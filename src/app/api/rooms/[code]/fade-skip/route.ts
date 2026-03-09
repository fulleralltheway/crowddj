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

    // If skip mode, lock the next song BEFORE fading so the queue shows what's coming
    if (mode === "skip") {
      const nextUp = await prisma.roomSong.findFirst({
        where: { roomId: room.id, isPlayed: false, isPlaying: false },
        orderBy: { sortOrder: "asc" },
      });
      if (nextUp && !nextUp.isLocked) {
        await prisma.roomSong.update({
          where: { id: nextUp.id },
          data: { isLocked: true },
        });
      }
    }

    // Safety: if volume is already very low, don't fade — just skip/pause
    // This prevents double-fading if the endpoint is called twice
    if (originalVolume < 10) {
      if (mode === "pause") {
        await pausePlayback(accessToken);
        try { await setVolume(accessToken, 80); } catch {}
        return NextResponse.json({ success: true, action: "paused", originalVolume: 80 });
      }
      // Fall through to skip logic without fading
    } else {
      // Fade out from current volume
      for (const mult of multipliers) {
        await setVolume(accessToken, Math.round(originalVolume * mult));
        await sleep(stepMs);
      }
      // Ensure we hit zero
      try { await setVolume(accessToken, 0); } catch {}
    }

    if (mode === "pause") {
      // Fade & Pause: pause playback first, then restore volume
      await pausePlayback(accessToken);
      await sleep(300);
      // Restore volume so next play resumes at correct level
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

      // 2. Restore volume while paused (works on most devices)
      try { await setVolume(accessToken, originalVolume); } catch {}
      await sleep(400);

      // 3. Start the next song
      const wasPreQueued = room.lastPreQueuedId === nextSong.id;
      try {
        if (wasPreQueued) {
          await skipToNext(accessToken);
        } else {
          await startPlayback(accessToken, [nextSong.spotifyUri]);
        }
      } catch {
        try {
          if (wasPreQueued) {
            await startPlayback(accessToken, [nextSong.spotifyUri]);
          } else {
            await skipToNext(accessToken);
          }
        } catch {}
      }

      // 4. CRITICAL: Set volume AGAIN after playback starts
      // Some Spotify devices ignore setVolume while paused, so the pre-start
      // volume set may not have taken effect. This second set while playing
      // is the reliable one.
      await sleep(300);
      try { await setVolume(accessToken, originalVolume); } catch {}

      // 5. Final verification — if still wrong, force it one more time
      await sleep(500);
      try {
        const check = await getCurrentPlayback(accessToken);
        const currentVol = check?.device?.volume_percent ?? 0;
        if (currentVol < originalVolume - 15) {
          await setVolume(accessToken, originalVolume);
        }
      } catch {}

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
    // Emergency volume restoration — don't leave the user stuck at volume 0
    try { await setVolume(accessToken, 80); } catch {}
    return NextResponse.json(
      { error: e.message || "Fade skip failed" },
      { status: 500 }
    );
  }
}
