import { prisma } from "@/lib/db";
import { getCurrentPlayback, getPlaylistTracks, pausePlayback, setVolume, startPlaybackContext } from "@/lib/spotify";
import { cachedPlaylistTracks } from "@/lib/spotify-cache";
import { buildFadeCurve } from "@/lib/fade-curve";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header = req.headers.get("authorization");
  if (header === `Bearer ${expected}`) return true;
  const param = req.nextUrl.searchParams.get("secret");
  return param === expected;
}

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

async function getAccessToken(account: {
  id: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
}): Promise<string | null> {
  if (!account.access_token) return null;
  if (!account.expires_at || account.expires_at * 1000 > Date.now()) {
    return account.access_token;
  }
  if (!account.refresh_token) return null;
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(
        `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
      ).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: account.refresh_token }),
  });
  const tokens = await res.json();
  if (!res.ok) return null;
  await prisma.account.update({
    where: { id: account.id },
    data: {
      access_token: tokens.access_token,
      expires_at: Math.floor(Date.now() / 1000 + tokens.expires_in),
      refresh_token: tokens.refresh_token ?? account.refresh_token,
    },
  });
  return tokens.access_token;
}

/**
 * Server-side fade + skip for a Bluegrass session. Called by the socket
 * server (precise-scheduled timer) or by sync-bluegrass with deferFade=false
 * (Vercel Cron fallback).
 */
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { sessionId?: string; expectedTrackUri?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (!body.sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }

  const sess = await prisma.bluegrassSession.findUnique({ where: { id: body.sessionId } });
  if (!sess) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  if (!sess.isActive) {
    return NextResponse.json({ skipped: true, reason: "session_inactive" });
  }

  // Race-safety: if the song already changed, don't double-skip.
  if (body.expectedTrackUri && sess.currentTrackUri && sess.currentTrackUri !== body.expectedTrackUri) {
    return NextResponse.json({ skipped: true, reason: "track_already_changed" });
  }

  // Concurrency guard: if another transition fired for this session within
  // 2*fadeDurationSec, treat this call as a duplicate. Atomic check-and-set
  // via updateMany so two concurrent callers can't both pass.
  //
  // Invariant: this only works for non-degenerate configs where
  // maxSongDurationSec >= 3*fadeDurationSec. Otherwise the next legitimate
  // auto-fade would land inside the cooldown window and be silently dropped.
  // PATCH validator at /api/bluegrass/sessions/[id] enforces 3x.
  const fadeMs = Math.max(500, sess.fadeDurationSec * 1000);
  const cooldownCutoff = new Date(Date.now() - 2 * fadeMs);
  const claimed = await prisma.bluegrassSession.updateMany({
    where: { id: sess.id, lastSyncAdvance: { lt: cooldownCutoff } },
    data: { lastSyncAdvance: new Date() },
  });
  if (claimed.count === 0) {
    return NextResponse.json({ skipped: true, reason: "concurrent_transition_in_flight" });
  }

  // If we bail before the actual transition, release the cooldown claim so
  // a retry on the next tick isn't blocked for 2*fadeMs.
  const releaseCooldown = async () => {
    try {
      await prisma.bluegrassSession.update({
        where: { id: sess.id },
        data: { lastSyncAdvance: cooldownCutoff },
      });
    } catch {}
  };

  const account = await prisma.account.findFirst({
    where: { userId: sess.userId, provider: "spotify" },
  });
  if (!account?.access_token) {
    await releaseCooldown();
    return NextResponse.json({ error: "no_token" }, { status: 401 });
  }

  const accessToken = await getAccessToken(account);
  if (!accessToken) {
    await releaseCooldown();
    return NextResponse.json({ error: "token_refresh_failed" }, { status: 401 });
  }

  const fadeDurationMs = Math.max(500, sess.fadeDurationSec * 1000);

  // Capture current volume + currently-playing track URI BEFORE the fade.
  // Spotify's track relinking surfaces both the relinked uri (item.uri)
  // and the original playlist uri (item.linked_from.uri). Match on either.
  let originalVolume = sess.targetVolume;
  let currentTrackUri: string | undefined;
  let currentLinkedFromUri: string | undefined;
  try {
    const playback = await getCurrentPlayback(accessToken);
    originalVolume = playback?.device?.volume_percent ?? sess.targetVolume;
    currentTrackUri = playback?.item?.uri;
    currentLinkedFromUri = playback?.item?.linked_from?.uri;
  } catch {}

  // Look up next track URI so we can use the explicit-URI transition pattern
  // PartyQueue's CLAUDE.md prescribes (skipToNext is unreliable). Skipped
  // for stopAfterCurrent since we're pausing not advancing.
  const playlistId = sess.playlistUri.replace(/^spotify:playlist:/, "");
  let nextTrackUri: string | undefined;
  if (!sess.stopAfterCurrent) {
    try {
      const tracks = await cachedPlaylistTracks(playlistId, () => getPlaylistTracks(accessToken, playlistId));
      if (tracks.length > 0) {
        let idx = -1;
        if (currentTrackUri) {
          idx = tracks.findIndex((t: { spotifyUri: string }) => t.spotifyUri === currentTrackUri);
        }
        if (idx < 0 && currentLinkedFromUri) {
          idx = tracks.findIndex((t: { spotifyUri: string }) => t.spotifyUri === currentLinkedFromUri);
        }
        const nextIdx = idx >= 0 ? (idx + 1) % tracks.length : 0;
        nextTrackUri = tracks[nextIdx].spotifyUri;
      }
    } catch {}
  }

  const { multipliers, stepMs } = buildFadeCurve(fadeDurationMs);

  if (originalVolume >= 10) {
    for (const mult of multipliers) {
      try { await setVolume(accessToken, Math.round(originalVolume * mult)); } catch {}
      await sleep(stepMs);
    }
    try { await setVolume(accessToken, 0); } catch {}
  }

  // "Stop after this song" mode: pause instead of advancing.
  if (sess.stopAfterCurrent) {
    // Pause first (volume is at 0, silent), THEN restore volume so a
    // subsequent resume comes back at target. Without the pause the track
    // would keep playing audibly the moment volume returns.
    try { await pausePlayback(accessToken); } catch {}
    await sleep(200);
    await restoreVolume(accessToken, sess.targetVolume);
    await prisma.bluegrassSession.update({
      where: { id: sess.id },
      data: { stopAfterCurrent: false },
    });
    return NextResponse.json({ ok: true, action: "stopped_after_song", fadedFrom: originalVolume });
  }

  // Otherwise, advance via the playlist context with an explicit offset URI.
  // Falls back to position 0 if we couldn't determine the next track —
  // better than leaving the user at zero volume.
  try {
    const offset = nextTrackUri ? { uri: nextTrackUri } : { position: 0 };
    await startPlaybackContext(accessToken, sess.playlistUri, sess.deviceId ?? undefined, offset);
  } catch {
    await restoreVolume(accessToken, sess.targetVolume);
    await releaseCooldown();
    return NextResponse.json({ error: "skip_failed" }, { status: 502 });
  }

  await sleep(300);
  await restoreVolume(accessToken, sess.targetVolume);

  // lastSyncAdvance was already set by the concurrency-guard updateMany above.
  await prisma.bluegrassSession.update({
    where: { id: sess.id },
    data: {
      trackStartedAt: new Date(),
      currentTrackUri: nextTrackUri ?? null,
    },
  });

  return NextResponse.json({ ok: true, action: "advanced", fadedFrom: originalVolume, nextTrackUri });
}
