import { prisma } from "@/lib/db";
import {
  getCurrentPlayback,
  pausePlayback,
  setVolume,
  skipToNext,
  startPlayback,
  startPlaybackContext,
} from "@/lib/spotify";
import { getNextSessionTrack, markCurrentPlayed } from "@/lib/bluegrass-queue";
import { buildFadeCurve } from "@/lib/fade-curve";
import type { BluegrassSession } from "@/generated/prisma/client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type FadeTransitionResult =
  | { ok: true; action: string; fadedFrom: number; nextTrackUri?: string | null; preloadedUri?: string | null; preloadOk?: boolean; source?: string }
  | { skipped: true; reason: string }
  | { error: string; status: number; detail?: string };

async function restoreVolume(accessToken: string, target: number, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await setVolume(accessToken, target);
      await sleep(500);
      const check = await getCurrentPlayback(accessToken);
      const actual = check?.device?.volume_percent ?? 0;
      if (actual >= target - 10) return;
    } catch {}
    await sleep(1000);
  }
  try { await setVolume(accessToken, target); } catch {}
}

/**
 * Run the full fade-out + advance (or fade-out + preload-and-pause for
 * stopAfterCurrent) for a Bluegrass session. Shared by:
 *   - the cron-driven socket path (`/api/cron/bluegrass-fade-transition`)
 *   - the session-scoped client-fallback path (`/api/bluegrass/sessions/[id]/fade-transition`)
 *
 * Centralising this here is load-bearing: divergence between the two paths
 * is exactly how the "stop-after-current resumes from top of playlist" bug
 * shipped on 2026-04-29 (cron fixed, client fallback still hit fade-pause
 * which doesn't preload). Keep both call sites going through this function.
 *
 * Caller responsibility: refresh + supply a valid Spotify access token.
 *
 * Returns one of:
 *   - { ok: true, ... } on a successful fade
 *   - { skipped: true, reason } when the concurrency guard rejects (a fade
 *     was already in flight) or the session is inactive
 *   - { error, status } for caller-actionable failures (no token, skip
 *     failed, etc.)
 */
export async function executeFadeTransition(
  sess: BluegrassSession,
  accessToken: string,
  expectedTrackUri?: string,
): Promise<FadeTransitionResult> {
  if (!sess.isActive) {
    return { skipped: true, reason: "session_inactive" };
  }

  // Race-safety: if the song already changed under us, don't double-skip.
  if (expectedTrackUri && sess.currentTrackUri && sess.currentTrackUri !== expectedTrackUri) {
    return { skipped: true, reason: "track_already_changed" };
  }

  // Concurrency guard: atomic check-and-set on lastSyncAdvance prevents two
  // concurrent fade callers (e.g. socket-driven cron + client-polling
  // threshold fallback) from both firing on the same threshold. Invariant
  // requires maxSongDurationSec >= 3 * fadeDurationSec so the next legitimate
  // auto-fade lands outside the cooldown window. Enforced by the PATCH
  // validator at /api/bluegrass/sessions/[id].
  const fadeDurationMs = Math.max(500, sess.fadeDurationSec * 1000);
  const cooldownCutoff = new Date(Date.now() - 2 * fadeDurationMs);
  const claimed = await prisma.bluegrassSession.updateMany({
    where: { id: sess.id, lastSyncAdvance: { lt: cooldownCutoff } },
    data: { lastSyncAdvance: new Date() },
  });
  if (claimed.count === 0) {
    return { skipped: true, reason: "concurrent_transition_in_flight" };
  }

  const releaseCooldown = async () => {
    try {
      await prisma.bluegrassSession.update({
        where: { id: sess.id },
        data: { lastSyncAdvance: cooldownCutoff },
      });
    } catch {}
  };

  // Capture device volume + currently-playing URI BEFORE the fade.
  let originalVolume = sess.targetVolume;
  let currentTrackUri: string | undefined;
  let currentLinkedFromUri: string | undefined;
  try {
    const playback = await getCurrentPlayback(accessToken);
    originalVolume = playback?.device?.volume_percent ?? sess.targetVolume;
    currentTrackUri = playback?.item?.uri;
    currentLinkedFromUri = playback?.item?.linked_from?.uri;
  } catch {}

  // CRITICAL ORDERING: mark the playing row as PLAYED before looking up the
  // next one, otherwise getNextSessionTrack returns the playing row (lowest
  // sortOrder among isPlayed=false) and we "advance" by replaying it.
  if (currentTrackUri) await markCurrentPlayed(sess.id, currentTrackUri);
  if (currentLinkedFromUri) await markCurrentPlayed(sess.id, currentLinkedFromUri);

  const nextRow = await getNextSessionTrack(sess.id);
  const { multipliers, stepMs } = buildFadeCurve(fadeDurationMs);

  if (originalVolume >= 10) {
    for (const mult of multipliers) {
      try { await setVolume(accessToken, Math.round(originalVolume * mult)); } catch {}
      await sleep(stepMs);
    }
    try { await setVolume(accessToken, 0); } catch {}
  }

  // ---- Stop-after-current branch -----------------------------------------
  // Preload the NEXT track (paused at ~position 0) so when the user resumes
  // it plays cleanly with fade-in. Without the preload, the OLD track would
  // resume at position past the threshold, immediately re-trip the fade,
  // and bleed into the next track ("tail audible" bug).
  //
  // Sleep timing matches PartyQueue's room-pause reference:
  //   500ms post-fade rate-limit cooldown
  // + 200ms pre-load
  // + 300ms post-startup
  // + 300ms post-pause
  // = 1300ms total before restoreVolume.
  if (sess.stopAfterCurrent) {
    try { await pausePlayback(accessToken); } catch {}
    await sleep(500);
    try { await setVolume(accessToken, 0); } catch {}
    await sleep(200);

    let preloadedUri: string | null = null;
    let preloadOk = true;
    try {
      if (nextRow) {
        try {
          await startPlaybackContext(
            accessToken,
            sess.playlistUri,
            sess.deviceId ?? undefined,
            { uri: nextRow.spotifyUri }
          );
          preloadedUri = nextRow.spotifyUri;
        } catch {
          // offset.uri rejected (manually-inserted track not in playlist
          // context, or other 4xx). Fall back to native skipToNext.
          await skipToNext(accessToken);
        }
      } else {
        await skipToNext(accessToken);
      }
    } catch {
      preloadOk = false;
    }

    await sleep(300);
    try { await pausePlayback(accessToken); } catch {}
    await sleep(300);
    await restoreVolume(accessToken, sess.targetVolume);

    // DB writes wrapped — even if Postgres flakes, the response still tells
    // the client what happened. stopAfterCurrent=false is the critical one
    // (so the next threshold doesn't re-fire stop mode).
    const updateData: { stopAfterCurrent: false; currentTrackUri?: string; trackStartedAt?: Date } = {
      stopAfterCurrent: false,
    };
    if (preloadedUri) {
      updateData.currentTrackUri = preloadedUri;
      updateData.trackStartedAt = new Date();
    }
    try {
      await prisma.bluegrassSession.update({ where: { id: sess.id }, data: updateData });
    } catch {
      try { await prisma.bluegrassSession.update({ where: { id: sess.id }, data: updateData }); } catch {}
    }
    if (preloadedUri && nextRow) {
      try {
        await prisma.bluegrassSessionTrack.update({
          where: { id: nextRow.id },
          data: { isPlaying: true },
        });
      } catch {}
    }

    return {
      ok: true,
      action: preloadedUri ? "stopped_after_song_preloaded" : "stopped_after_song_advanced",
      fadedFrom: originalVolume,
      preloadedUri,
      preloadOk,
    };
  }

  // ---- Normal advance branch --------------------------------------------
  // Preserve playlist context as the queue context so Spotify auto-advances
  // after the new track ends. Fixes the "music stops" bug.
  let nextTrackUri: string | undefined;
  try {
    if (nextRow) {
      nextTrackUri = nextRow.spotifyUri;
      try {
        await startPlaybackContext(
          accessToken,
          sess.playlistUri,
          sess.deviceId ?? undefined,
          { uri: nextTrackUri }
        );
      } catch {
        // offset.uri not in context — defensive single-URI fallback. Loses
        // auto-advance for that one track but the next transition handles it.
        await startPlayback(accessToken, [nextTrackUri], sess.deviceId ?? undefined);
      }
      await prisma.bluegrassSessionTrack.update({
        where: { id: nextRow.id },
        data: { isPlaying: true },
      });
    } else {
      await skipToNext(accessToken);
    }
  } catch (e) {
    await restoreVolume(accessToken, sess.targetVolume);
    await releaseCooldown();
    return { error: "skip_failed", status: 502, detail: e instanceof Error ? e.message : "" };
  }

  await sleep(300);
  await restoreVolume(accessToken, sess.targetVolume);

  await prisma.bluegrassSession.update({
    where: { id: sess.id },
    data: { trackStartedAt: new Date(), currentTrackUri: nextTrackUri ?? null },
  });

  return {
    ok: true,
    action: "advanced",
    fadedFrom: originalVolume,
    nextTrackUri,
    source: nextRow ? "db_queue" : "spotify_native_skip",
  };
}
