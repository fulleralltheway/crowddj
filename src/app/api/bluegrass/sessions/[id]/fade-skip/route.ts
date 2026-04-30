import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getCurrentPlayback, setVolume, skipToNext, startPlaybackContext } from "@/lib/spotify";
import { getNextSessionTrack, markCurrentPlayed } from "@/lib/bluegrass-queue";
import { buildFadeCurve } from "@/lib/fade-curve";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth_ = await auth();
  if (!auth_?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const sess = await prisma.bluegrassSession.findUnique({ where: { id } });
  if (!sess || sess.userId !== auth_.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!sess.isActive) {
    return NextResponse.json({ error: "session_inactive" }, { status: 409 });
  }

  const accessToken = (auth_ as { accessToken?: string }).accessToken;
  if (!accessToken) {
    return NextResponse.json({ error: "no_token" }, { status: 401 });
  }

  const fadeDurationMs = Math.max(500, sess.fadeDurationSec * 1000);

  // Concurrency guard against client-polling fallback + socket-driven cron
  // racing on the same threshold. Atomic check-and-set on lastSyncAdvance.
  // Invariant requires max >= 3*fade (enforced by PATCH validator) so that
  // legitimate consecutive auto-fades land outside the cooldown window.
  const cooldownCutoff = new Date(Date.now() - 2 * fadeDurationMs);
  const claimed = await prisma.bluegrassSession.updateMany({
    where: { id: sess.id, lastSyncAdvance: { lt: cooldownCutoff } },
    data: { lastSyncAdvance: new Date() },
  });
  if (claimed.count === 0) {
    return NextResponse.json({ skipped: true, reason: "concurrent_transition_in_flight" });
  }

  // Capture current device volume + currently-playing URI BEFORE fading.
  let originalVolume = sess.targetVolume;
  let currentTrackUri: string | undefined;
  let currentLinkedFromUri: string | undefined;
  try {
    const playback = await getCurrentPlayback(accessToken);
    originalVolume = playback?.device?.volume_percent ?? sess.targetVolume;
    currentTrackUri = playback?.item?.uri;
    currentLinkedFromUri = playback?.item?.linked_from?.uri;
  } catch {}

  // CRITICAL ORDERING: mark the currently-playing row as PLAYED before we
  // ask for the next one. Without this, getNextSessionTrack can return the
  // row that's still playing (lowest sortOrder among isPlayed=false), and
  // we'd "advance" by replaying the same track. Idempotent on miss.
  if (currentTrackUri) await markCurrentPlayed(id, currentTrackUri);
  if (currentLinkedFromUri) await markCurrentPlayed(id, currentLinkedFromUri);

  // ADR 0002: look up next track from the DB queue, not from
  // /v1/playlists/{id}/tracks. After import + the markCurrentPlayed above,
  // this returns the genuinely-next unplayed row.
  const nextRow = await getNextSessionTrack(id);

  const { multipliers, stepMs } = buildFadeCurve(fadeDurationMs);

  // Fade out, but never below 0
  if (originalVolume >= 10) {
    for (const mult of multipliers) {
      try { await setVolume(accessToken, Math.round(originalVolume * mult)); } catch {}
      await sleep(stepMs);
    }
    try { await setVolume(accessToken, 0); } catch {}
  }

  // Three-tier fallback for the actual transition:
  //   1. DB queue has a next track → startPlayback with explicit URI (ideal)
  //   2. DB queue empty (import never ran or all played) → Spotify's native
  //      skipToNext, which advances the playlist context. /me/player/next is
  //      in a separate rate-limit bucket from /v1/playlists/* so it stays
  //      available even when playlist endpoints are throttled.
  //   3. Both fail → restore volume, release cooldown, return error. Do NOT
  //      restart the playlist from position 0 — that's worse than no skip.
  let nextTrackUri: string | undefined;
  try {
    if (nextRow) {
      nextTrackUri = nextRow.spotifyUri;
      // Use context+offset so the playlist stays the queue context. Without
      // this Spotify ends up with a single-URI queue and stops after the
      // played track ends — the "music stops with no track" bug.
      await startPlaybackContext(
        accessToken,
        sess.playlistUri,
        sess.deviceId ?? undefined,
        { uri: nextTrackUri }
      );
      await prisma.bluegrassSessionTrack.update({
        where: { id: nextRow.id },
        data: { isPlaying: true },
      });
    } else {
      await skipToNext(accessToken);
    }
  } catch (e) {
    await restoreVolume(accessToken, originalVolume || sess.targetVolume);
    try {
      await prisma.bluegrassSession.update({
        where: { id },
        data: { lastSyncAdvance: cooldownCutoff },
      });
    } catch {}
    return NextResponse.json(
      { error: "skip_failed", detail: e instanceof Error ? e.message : "" },
      { status: 502 }
    );
  }

  // Give Spotify a moment to load the next track, then restore volume.
  await sleep(300);
  await restoreVolume(accessToken, sess.targetVolume);

  // lastSyncAdvance was already set by the concurrency guard above.
  await prisma.bluegrassSession.update({
    where: { id },
    data: { trackStartedAt: new Date(), currentTrackUri: nextTrackUri ?? null },
  });

  return NextResponse.json({
    ok: true,
    fadedFrom: originalVolume,
    nextTrackUri,
    source: nextRow ? "db_queue" : "spotify_native_skip",
  });
}
