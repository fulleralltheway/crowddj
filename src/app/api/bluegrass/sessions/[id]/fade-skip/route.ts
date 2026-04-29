import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getCurrentPlayback, getPlaylistTracks, setVolume, startPlaybackContext } from "@/lib/spotify";
import { cachedPlaylistTracks } from "@/lib/spotify-cache";
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

  // Determine current track + next track BEFORE fading. Doing this up-front
  // also catches the "device went silent / Spotify lost the context" case
  // before we've started ramping volume down.
  let originalVolume = sess.targetVolume;
  let currentTrackUri: string | undefined;
  // Spotify's track relinking: when a track has a region-specific replacement,
  // playback.item.uri is the RELINKED uri, while the playlist still stores
  // the ORIGINAL uri at item.linked_from.uri. Both forms must be considered
  // when matching the playing track against the playlist.
  let currentLinkedFromUri: string | undefined;
  try {
    const playback = await getCurrentPlayback(accessToken);
    originalVolume = playback?.device?.volume_percent ?? sess.targetVolume;
    currentTrackUri = playback?.item?.uri;
    currentLinkedFromUri = playback?.item?.linked_from?.uri;
  } catch {}

  // Look up the next track URI in the playlist. PartyQueue's CLAUDE.md flags
  // skipToNext as unreliable; the proven pattern is startPlayback with an
  // explicit URI / context+offset. We use context+offset.uri so Spotify
  // keeps the playlist as the queue context (continued auto-advance + the
  // user's native crossfade work after our cut).
  const playlistId = sess.playlistUri.replace(/^spotify:playlist:/, "");
  let nextTrackUri: string | undefined;
  // Diagnostic state surfaced in the response so failures are debuggable
  // from the client without spelunking Vercel logs.
  let trackCount = 0;
  let matchKind: "uri" | "linked_from" | "none" = "none";
  let resolvedIdx = -1;
  let lookupError: string | undefined;
  try {
    const tracks = await cachedPlaylistTracks(playlistId, () => getPlaylistTracks(accessToken, playlistId));
    trackCount = tracks.length;
    if (tracks.length > 0) {
      let idx = -1;
      if (currentTrackUri) {
        idx = tracks.findIndex((t: { spotifyUri: string }) => t.spotifyUri === currentTrackUri);
        if (idx >= 0) matchKind = "uri";
      }
      if (idx < 0 && currentLinkedFromUri) {
        idx = tracks.findIndex((t: { spotifyUri: string }) => t.spotifyUri === currentLinkedFromUri);
        if (idx >= 0) matchKind = "linked_from";
      }
      resolvedIdx = idx;
      const nextIdx = idx >= 0 ? (idx + 1) % tracks.length : 0;
      nextTrackUri = tracks[nextIdx].spotifyUri;
    }
  } catch (e) {
    lookupError = e instanceof Error ? e.message : "unknown";
  }

  const { multipliers, stepMs } = buildFadeCurve(fadeDurationMs);

  // Fade out, but never below 0
  if (originalVolume >= 10) {
    for (const mult of multipliers) {
      try { await setVolume(accessToken, Math.round(originalVolume * mult)); } catch {}
      await sleep(stepMs);
    }
    try { await setVolume(accessToken, 0); } catch {}
  }

  // Start the next track via the playlist context with explicit offset.
  // If we couldn't determine a next URI, fall back to "play playlist from
  // position 0" — better than leaving the user paused at zero volume.
  try {
    const offset = nextTrackUri ? { uri: nextTrackUri } : { position: 0 };
    await startPlaybackContext(accessToken, sess.playlistUri, sess.deviceId ?? undefined, offset);
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
    diagnostics: {
      currentTrackUri,
      currentLinkedFromUri,
      matchKind,            // "uri" | "linked_from" | "none"
      resolvedIdx,          // -1 = current track not in playlist; fell back to position 0
      trackCount,
      lookupError,
    },
  });
}
