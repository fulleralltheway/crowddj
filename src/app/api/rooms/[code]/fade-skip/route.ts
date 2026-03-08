import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { startPlayback, getCurrentPlayback, setVolume } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(
  _req: NextRequest,
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

  try {
    // Get current playback to know the starting volume
    const playback = await getCurrentPlayback(accessToken);
    const originalVolume = playback?.device?.volume_percent ?? 80;

    // Fade out over ~2.5 seconds (5 steps)
    const steps = [
      Math.round(originalVolume * 0.7),
      Math.round(originalVolume * 0.45),
      Math.round(originalVolume * 0.25),
      Math.round(originalVolume * 0.1),
      0,
    ];

    for (const vol of steps) {
      await setVolume(accessToken, vol);
      await sleep(500);
    }

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

    // Set next song as playing
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

    // Fade volume back up over ~1.5 seconds (3 steps)
    const fadeIn = [
      Math.round(originalVolume * 0.4),
      Math.round(originalVolume * 0.7),
      originalVolume,
    ];

    for (const vol of fadeIn) {
      await setVolume(accessToken, vol);
      await sleep(500);
    }

    return NextResponse.json({ success: true, song: nextSong, originalVolume });
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message || "Fade skip failed" },
      { status: 500 }
    );
  }
}
