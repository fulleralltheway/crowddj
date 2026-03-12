import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getNextSong, shiftPinnedPositions } from "@/lib/queue";
import { startPlayback, getCurrentPlayback, setVolume, pausePlayback } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

// Vercel hobby default is 10s — fades with volume restore need more time
export const maxDuration = 60;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Build a smooth fade-out curve for any duration.
 * Returns an array of volume multipliers (1.0 → 0.0) with even spacing.
 * Uses an ease-out curve so the fade feels natural (slows down toward silence).
 */
function buildFadeCurve(durationMs: number): { multipliers: number[]; stepMs: number } {
  // Use fewer steps for longer fades to avoid Spotify API rate limits
  // Short fades (1-3s): 4 steps/sec, long fades (5s+): 2 steps/sec
  const stepsPerSec = durationMs <= 3000 ? 4 : 2;
  const totalSteps = Math.max(2, Math.min(24, Math.round((durationMs / 1000) * stepsPerSec)));
  const stepMs = Math.round(durationMs / totalSteps);

  const multipliers: number[] = [];
  for (let i = 1; i <= totalSteps; i++) {
    const t = i / totalSteps;
    const vol = Math.pow(1 - t, 1.8);
    multipliers.push(Math.max(0, vol));
  }

  return { multipliers, stepMs };
}

// Restore volume with retries — critical after fade to avoid stuck-at-zero
async function restoreVolume(accessToken: string, targetVolume: number, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await setVolume(accessToken, targetVolume);
      // Verify it took effect
      await sleep(500);
      const check = await getCurrentPlayback(accessToken);
      const actual = check?.device?.volume_percent ?? 0;
      if (actual >= targetVolume - 10) return; // Close enough
    } catch {}
    await sleep(1000); // Longer cooldown between retries for rate limit recovery
  }
  // Last-resort attempt
  try { await setVolume(accessToken, targetVolume); } catch {}
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const accessToken = (session as any).accessToken;
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.hostId !== session.user.id) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  let fadeDurationMs = 2500;
  let mode: "skip" | "pause" = "skip";
  try {
    const body = await req.json();
    if (typeof body.fadeDurationMs === "number") {
      fadeDurationMs = Math.max(500, Math.min(30000, body.fadeDurationMs));
    }
    if (body.mode === "pause") mode = "pause";
  } catch {}

  const { multipliers, stepMs } = buildFadeCurve(fadeDurationMs);

  // Determine the next song BEFORE fading so we know exactly what to play
  let lockedNextSong: any = null;
  let originalVolume = 80;

  try {
    const playback = await getCurrentPlayback(accessToken);
    originalVolume = playback?.device?.volume_percent ?? 80;

    // Lock the next song in DB so UI shows it as "up next"
    const nextUp = await getNextSong(room.id, room.autoShuffle);
    if (nextUp) {
      lockedNextSong = nextUp;
      if (!nextUp.isLocked) {
        await prisma.roomSong.update({
          where: { id: nextUp.id },
          data: { isLocked: true },
        });
      }
    }

    // Safety: if volume is already very low, don't fade — just skip/pause
    if (originalVolume < 10) {
      if (mode === "pause") {
        await pausePlayback(accessToken);
        try { await setVolume(accessToken, 80); } catch {}
        // Still advance queue for pause-stop mode
        originalVolume = 80;
      }
    } else {
      // Fade out — each step wrapped in try/catch so one error doesn't abort
      for (const mult of multipliers) {
        try { await setVolume(accessToken, Math.round(originalVolume * mult)); } catch {}
        await sleep(stepMs);
      }
      try { await setVolume(accessToken, 0); } catch {}
    }

    // Immediately pause — never leave a song playing at volume 0
    try { await pausePlayback(accessToken); } catch {}

    if (mode === "pause") {
      // Mark current song as played and load the next song (but leave paused)
      const playing = await prisma.roomSong.findFirst({
        where: { roomId: room.id, isPlaying: true },
      });
      if (playing) {
        await prisma.roomSong.update({
          where: { id: playing.id },
          data: { isPlaying: false, isPlayed: true },
        });
      }

      const nextSong = lockedNextSong ?? await getNextSong(room.id, room.autoShuffle);
      if (nextSong) {
        await prisma.roomSong.update({
          where: { id: nextSong.id },
          data: { isPlaying: true, isLocked: false },
        });

        // Load next song silently: keep volume at 0, start, immediately pause, then restore volume
        await sleep(500); // Rate limit cooldown after fade
        try { await setVolume(accessToken, 0); } catch {}
        await sleep(200);
        try { await startPlayback(accessToken, [nextSong.spotifyUri]); } catch {}
        await sleep(300);
        try { await pausePlayback(accessToken); } catch {}
        await sleep(300);
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

        return NextResponse.json({ success: true, action: "stopped", song: nextSong.trackName, originalVolume });
      } else {
        // No next song — just restore volume and stay paused
        await sleep(500);
        await restoreVolume(accessToken, originalVolume);
        return NextResponse.json({ success: true, action: "stopped", song: null, originalVolume });
      }
    }

    // Mode: skip — advance to next song
    const playing = await prisma.roomSong.findFirst({
      where: { roomId: room.id, isPlaying: true },
    });
    if (playing) {
      await prisma.roomSong.update({
        where: { id: playing.id },
        data: { isPlaying: false, isPlayed: true },
      });
    }

    const nextSong = lockedNextSong ?? await getNextSong(room.id, room.autoShuffle);

    if (nextSong) {
      await prisma.roomSong.update({
        where: { id: nextSong.id },
        data: { isPlaying: true, isLocked: false },
      });

      // Rate limit cooldown after rapid fade steps — 1.5s lets Spotify API recover
      await sleep(1500);
      await restoreVolume(accessToken, originalVolume);

      // Start the exact song by URI — never skipToNext which plays unknown songs
      try {
        await startPlayback(accessToken, [nextSong.spotifyUri]);
      } catch {
        // Retry once
        await sleep(500);
        try { await startPlayback(accessToken, [nextSong.spotifyUri]); } catch {}
      }

      // Set volume AGAIN after playback starts (some devices ignore while paused)
      await sleep(500);
      await restoreVolume(accessToken, originalVolume);

      // Final safety net — verify volume after a longer delay
      await sleep(1500);
      try {
        const check = await getCurrentPlayback(accessToken);
        const actual = check?.device?.volume_percent ?? originalVolume;
        if (actual < originalVolume - 10) {
          await setVolume(accessToken, originalVolume);
        }
      } catch {}

      // Clear pre-queue, debounce cron, track stats
      await prisma.room.update({
        where: { id: room.id },
        data: {
          lastPreQueuedId: null,
          lastSyncAdvance: new Date(),
          totalSongsPlayed: { increment: 1 },
        },
      });
      await shiftPinnedPositions(room.id);
    } else {
      try { await pausePlayback(accessToken); } catch {}
      await sleep(500);
      await restoreVolume(accessToken, originalVolume);
    }

    return NextResponse.json({ success: true, action: "skipped", song: nextSong?.trackName, originalVolume });
  } catch (e: any) {
    // Emergency recovery — pause and restore volume
    try { await pausePlayback(accessToken); } catch {}
    await sleep(500);
    await restoreVolume(accessToken, originalVolume);
    // Still try to advance the queue
    try {
      const playing = await prisma.roomSong.findFirst({
        where: { roomId: room.id, isPlaying: true },
      });
      if (playing) {
        await prisma.roomSong.update({
          where: { id: playing.id },
          data: { isPlaying: false, isPlayed: true },
        });
      }
      const nextSong = lockedNextSong ?? await getNextSong(room.id, room.autoShuffle);
      if (nextSong) {
        await prisma.roomSong.update({
          where: { id: nextSong.id },
          data: { isPlaying: true, isLocked: false },
        });
        try { await startPlayback(accessToken, [nextSong.spotifyUri]); } catch {}
        await sleep(500);
        await restoreVolume(accessToken, originalVolume);
        await shiftPinnedPositions(room.id);
      }
    } catch {}
    return NextResponse.json(
      { error: e.message || "Fade skip failed" },
      { status: 500 }
    );
  }
}
