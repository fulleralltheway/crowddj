import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const limit = Number(req.nextUrl.searchParams.get("limit")) || 50;

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });

  const songs = await prisma.roomSong.findMany({
    where: { roomId: room.id, isPlayed: false },
    orderBy: [{ isPlaying: "desc" }, { sortOrder: "asc" }],
    take: limit,
    include: {
      votes: { select: { guestId: true, value: true } },
    },
  });

  const sorted = songs.map((s) => ({
    ...s,
    netScore: s.upvotes - s.downvotes,
  }));

  return NextResponse.json(sorted);
}
