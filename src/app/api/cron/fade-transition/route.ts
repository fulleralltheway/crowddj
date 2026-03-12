import { prisma } from "@/lib/db";
import { getNextSong, shiftPinnedPositions } from "@/lib/queue";
import { startPlayback, getCurrentPlayback, setVolume, pausePlayback } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

// Long-running — fade can take up to 12s + volume restore
export const maxDuration = 60;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildFadeCurve(durationMs: number) {
  // Fewer steps for longer fades to avoid Spotify API rate limits
  const stepsPerSec = durationMs <= 3000 ? 4 : 2;
  const totalSteps = Math.max(2, Math.min(24, Math.round((durationMs / 1000) * stepsPerSec)));
  const stepMs = Math.round(durationMs / totalSteps);
  const multipliers: number[] = [];
  for (let i = 1; i <= totalSteps; i++) {
    const t = i / totalSteps;
    multipliers.push(Math.max(0, Math.pow(1 - t, 1.8)));
  }
  return { multipliers, stepMs };
}

async function restoreVolume(accessToken: string, targetVolume: number, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await setVolume(accessToken, targetVolume);
      await sleep(300);
      const check = await getCurrentPlayback(accessToken);
      const actual = check?.device?.volume_percent ?? 0;
      if (actual >= targetVolume - 10) return;
    } catch {}
    await sleep(500);
  }
  try { await setVolume(accessToken, targetVolume); } catch {}
}

/**
 * Server-side fade transition — called by the socket server when
 * the owner's app isn't open. Uses CRON_SECRET for auth and reads
 * the host's Spotify token from the Account table.
 *
 * POST body: { roomCode, fadeDurationMs? }
 */
export async function POST(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let roomCode: string;
  let expectedSongId: string | undefined;
  try {
    const body = await req.json();
    roomCode = body.roomCode;
    expectedSongId = body.expectedSongId;
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const room = await prisma.room.findUnique({ where: { code: roomCode } });
  if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });

  // Safety check: verify the expected song is still playing
  // Prevents double-advances when client and server race
  if (expectedSongId) {
    const currentPlaying = await prisma.roomSong.findFirst({
      where: { roomId: room.id, isPlaying: true },
    });
    if (!currentPlaying || currentPlaying.id !== expectedSongId) {
      return NextResponse.json({ skipped: true, reason: "Song already changed" });
    }
  }

  // Read fade duration from the room's saved settings
  const fadeDurationMs = (room.fadeDurationSec ?? 3) * 1000;

  // Get the host's Spotify access token
  const account = await prisma.account.findFirst({
    where: { userId: room.hostId, provider: "spotify" },
  });
  if (!account?.access_token) {
    return NextResponse.json({ error: "No token" }, { status: 401 });
  }

  let accessToken = account.access_token;

  // Refresh if expired
  if (account.expires_at && account.expires_at * 1000 < Date.now()) {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(
          `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
        ).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: account.refresh_token!,
      }),
    });
    const tokens = await res.json();
    if (!res.ok) return NextResponse.json({ error: "Token refresh failed" }, { status: 401 });

    accessToken = tokens.access_token;
    await prisma.account.update({
      where: { id: account.id },
      data: {
        access_token: tokens.access_token,
        expires_at: Math.floor(Date.now() / 1000 + tokens.expires_in),
        refresh_token: tokens.refresh_token ?? account.refresh_token,
      },
    });
  }

  const { multipliers, stepMs } = buildFadeCurve(fadeDurationMs);
  let originalVolume = 80;

  try {
    const playback = await getCurrentPlayback(accessToken);
    originalVolume = playback?.device?.volume_percent ?? 80;

    // Lock the next song
    const nextUp = await getNextSong(room.id, room.autoShuffle);
    if (nextUp && !nextUp.isLocked) {
      await prisma.roomSong.update({
        where: { id: nextUp.id },
        data: { isLocked: true },
      });
    }
    if (nextUp) {
      await prisma.room.update({
        where: { id: room.id },
        data: { lastPreQueuedId: nextUp.id, lastSyncAdvance: new Date() },
      });
    }

    // Fade out
    if (originalVolume >= 10) {
      for (const mult of multipliers) {
        try { await setVolume(accessToken, Math.round(originalVolume * mult)); } catch {}
        await sleep(stepMs);
      }
      try { await setVolume(accessToken, 0); } catch {}
    }

    // Pause
    try { await pausePlayback(accessToken); } catch {}

    // Mark current song as played
    const playing = await prisma.roomSong.findFirst({
      where: { roomId: room.id, isPlaying: true },
    });
    if (playing) {
      await prisma.roomSong.update({
        where: { id: playing.id },
        data: { isPlaying: false, isPlayed: true },
      });
    }

    // Start next song
    const nextSong = nextUp ?? await getNextSong(room.id, room.autoShuffle);
    if (nextSong) {
      await prisma.roomSong.update({
        where: { id: nextSong.id },
        data: { isPlaying: true, isLocked: false },
      });

      await sleep(800);
      await restoreVolume(accessToken, originalVolume);

      try { await startPlayback(accessToken, [nextSong.spotifyUri]); } catch {
        await sleep(500);
        try { await startPlayback(accessToken, [nextSong.spotifyUri]); } catch {}
      }

      await sleep(500);
      await restoreVolume(accessToken, originalVolume);

      await prisma.room.update({
        where: { id: room.id },
        data: {
          lastPreQueuedId: null,
          lastSyncAdvance: new Date(),
          totalSongsPlayed: { increment: 1 },
        },
      });
      await shiftPinnedPositions(room.id);

      return NextResponse.json({ success: true, action: "faded", song: nextSong.trackName, originalVolume });
    } else {
      await sleep(500);
      await restoreVolume(accessToken, originalVolume);
      return NextResponse.json({ success: true, action: "paused_end", originalVolume });
    }
  } catch (e: any) {
    try { await pausePlayback(accessToken); } catch {}
    await sleep(500);
    await restoreVolume(accessToken, originalVolume);
    return NextResponse.json({ error: e.message || "Fade transition failed" }, { status: 500 });
  }
}
