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

  const { songId, pin, position } = await req.json();
  if (!songId || typeof pin !== "boolean") {
    return NextResponse.json({ error: "Missing songId or pin" }, { status: 400 });
  }

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.hostId !== session.user.id) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const song = await prisma.roomSong.findFirst({
    where: { id: songId, roomId: room.id },
  });
  if (!song) return NextResponse.json({ error: "Song not found" }, { status: 404 });

  if (pin) {
    // Pin the song: lock it and set pinned position
    await prisma.roomSong.update({
      where: { id: songId },
      data: {
        isPinned: true,
        pinnedPosition: position ?? null,
        isLocked: true,
      },
    });
  } else {
    // Unpin: remove pin but keep locked status as-is (user can unlock separately)
    await prisma.roomSong.update({
      where: { id: songId },
      data: {
        isPinned: false,
        pinnedPosition: null,
        // Also unlock when unpinning, unless it was manually DJ-locked before
        isLocked: false,
      },
    });
  }

  return NextResponse.json({ success: true, pinned: pin });
}
