import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { startPlayback, getCurrentPlayback, setVolume, pausePlayback, skipToNext } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Build a smooth fade-out curve for any duration.
 * Returns an array of volume multipliers (1.0 → 0.0) with even spacing.
 * Uses an ease-out curve so the fade feels natural (slows down toward silence).
 */
function buildFadeCurve(durationMs: number): { multipliers: number[]; stepMs: number } {
  // ~6-8 steps per second feels smooth without hammering the API
  const stepsPerSec = 6;
  const totalSteps = Math.max(2, Math.round((durationMs / 1000) * stepsPerSec));
  const stepMs = Math.round(durationMs / totalSteps);

  const multipliers: number[] = [];
  for (let i = 1; i <= totalSteps; i++) {
    const t = i / totalSteps; // 0→1
    // Ease-out curve: starts fast, slows near silence
    const vol = Math.pow(1 - t, 1.8);
    multipliers.push(Math.max(0, vol));
  }

  return { multipliers, stepMs };
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

  // Parse options: fadeDurationMs (number) and mode ("skip" | "pause")
  let fadeDurationMs = 2500; // default 2.5s
  let mode: "skip" | "pause" = "skip";
  try {
    const body = await req.json();
    if (typeof body.fadeDurationMs === "number") {
      fadeDurationMs = Math.max(500, Math.min(30000, body.fadeDurationMs));
    }
    if (body.mode === "pause") mode = "pause";
  } catch {
    // No body or invalid JSON — use defaults
  }

  const { multipliers, stepMs } = buildFadeCurve(fadeDurationMs);

  try {
    // Get current playback to know the starting volume
    const playback = await getCurrentPlayback(accessToken);
    const originalVolume = playback?.device?.volume_percent ?? 80;

    // Fade out
    for (const mult of multipliers) {
      await setVolume(accessToken, Math.round(originalVolume * mult));
      await sleep(stepMs);
    }

    if (mode === "pause") {
      // Fade & Pause: pause playback first, then restore volume.
      // Some Spotify devices ignore volume changes while paused, so we
      // also return originalVolume for the play/skip routes to restore.
      await pausePlayback(accessToken);
      // Small delay to let pause settle before restoring volume
      await sleep(300);
      try { await setVolume(accessToken, originalVolume); } catch {}
      return NextResponse.json({ success: true, action: "paused", originalVolume });
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

    const nextSong = await prisma.roomSong.findFirst({
      where: { roomId: room.id, isPlayed: false, isPlaying: false },
      orderBy: { sortOrder: "asc" },
    });

    if (nextSong) {
      await prisma.roomSong.update({
        where: { id: nextSong.id },
        data: { isPlaying: true, isLocked: false },
      });

      // 1. Pause the faded-out song so nothing is playing at volume 0
      try { await pausePlayback(accessToken); } catch {}

      // 2. Restore volume while nothing is playing — this is reliable
      await setVolume(accessToken, originalVolume);

      // 3. Wait for Spotify to apply the volume change
      await sleep(400);

      // 4. Now start the next song at full volume
      const wasPreQueued = room.lastPreQueuedId === nextSong.id;
      try {
        // Always use startPlayback after a pause — skipToNext doesn't work
        // reliably from a paused state and can play the wrong song
        await startPlayback(accessToken, [nextSong.spotifyUri]);
      } catch {
        // Fallback: try skipToNext if startPlayback fails
        try { await skipToNext(accessToken); } catch {}
      }

      // Update room: clear pre-queue, debounce cron, track stats
      await prisma.room.update({
        where: { id: room.id },
        data: {
          lastPreQueuedId: null,
          lastSyncAdvance: new Date(),
          totalSongsPlayed: { increment: 1 },
        },
      });
    } else {
      // No next song — pause and restore volume
      try { await pausePlayback(accessToken); } catch {}
      await setVolume(accessToken, originalVolume);
    }

    return NextResponse.json({ success: true, action: "skipped", song: nextSong, originalVolume });
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message || "Fade skip failed" },
      { status: 500 }
    );
  }
}
