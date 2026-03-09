import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

/**
 * Lock the next unplayed song in the queue so the UI shows it as "up next"
 * before a fade/skip begins. Returns the locked song info.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.hostId !== session.user.id) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const nextSong = await prisma.roomSong.findFirst({
    where: { roomId: room.id, isPlayed: false, isPlaying: false },
    orderBy: { sortOrder: "asc" },
  });

  if (!nextSong) {
    return NextResponse.json({ success: true, song: null });
  }

  if (!nextSong.isLocked) {
    await prisma.roomSong.update({
      where: { id: nextSong.id },
      data: { isLocked: true },
    });
  }

  return NextResponse.json({
    success: true,
    song: { id: nextSong.id, trackName: nextSong.trackName, artistName: nextSong.artistName },
  });
}
