import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { songId, forceLock } = await req.json();
  if (!songId) return NextResponse.json({ error: "Missing songId" }, { status: 400 });

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.hostId !== session.user.id) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const song = await prisma.roomSong.findFirst({
    where: { id: songId, roomId: room.id },
  });
  if (!song) return NextResponse.json({ error: "Song not found" }, { status: 404 });

  const newLocked = forceLock === true ? true : !song.isLocked;
  await prisma.roomSong.update({
    where: { id: songId },
    data: { isLocked: newLocked },
  });

  return NextResponse.json({ success: true, locked: newLocked });
}
