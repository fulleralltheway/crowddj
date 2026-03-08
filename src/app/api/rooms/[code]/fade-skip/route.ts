import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { startPlayback, getCurrentPlayback, setVolume, pausePlayback } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fade step configurations by speed
const FADE_CONFIGS = {
  fast:   { multipliers: [0.5, 0.15, 0],         stepMs: 350 },
  medium: { multipliers: [0.7, 0.45, 0.25, 0.1, 0], stepMs: 500 },
  slow:   { multipliers: [0.8, 0.6, 0.45, 0.3, 0.18, 0.08, 0], stepMs: 700 },
};

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

  // Parse options from request body
  let speed: keyof typeof FADE_CONFIGS = "medium";
  let mode: "skip" | "pause" = "skip";
  try {
    const body = await req.json();
    if (body.speed && body.speed in FADE_CONFIGS) speed = body.speed;
    if (body.mode === "pause") mode = "pause";
  } catch {
    // No body or invalid JSON — use defaults
  }

  const config = FADE_CONFIGS[speed];

  try {
    // Get current playback to know the starting volume
    const playback = await getCurrentPlayback(accessToken);
    const originalVolume = playback?.device?.volume_percent ?? 80;

    // Fade out
    for (const mult of config.multipliers) {
      await setVolume(accessToken, Math.round(originalVolume * mult));
      await sleep(config.stepMs);
    }

    if (mode === "pause") {
      // Fade & Pause: just pause playback, don't advance
      await pausePlayback(accessToken);
      // Restore volume so when they resume it's at normal level
      await setVolume(accessToken, originalVolume);
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

      try {
        await startPlayback(accessToken, [nextSong.spotifyUri]);
      } catch {
        // Spotify playback failed
      }

      await prisma.room.update({ where: { id: room.id }, data: { lastPreQueuedId: null } });
    }

    // Fade volume back up (3 quick steps regardless of fade-out speed)
    const fadeIn = [
      Math.round(originalVolume * 0.4),
      Math.round(originalVolume * 0.7),
      originalVolume,
    ];

    for (const vol of fadeIn) {
      await setVolume(accessToken, vol);
      await sleep(400);
    }

    return NextResponse.json({ success: true, action: "skipped", song: nextSong, originalVolume });
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message || "Fade skip failed" },
      { status: 500 }
    );
  }
}
