import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { startPlayback } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

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
    // Unlock it (may have been locked as "queued next") and set as playing
    await prisma.roomSong.update({
      where: { id: nextSong.id },
      data: { isPlaying: true, isLocked: false },
    });

    // Play this song
    try {
      await startPlayback(accessToken, [nextSong.spotifyUri]);
    } catch {
      // Spotify playback failed (e.g. no active device)
    }

    // Clear pre-queue — cron will queue the next song when ~15s remain
    await prisma.room.update({ where: { id: room.id }, data: { lastPreQueuedId: null } });
  }

  return NextResponse.json({ success: true, song: nextSong });
}
