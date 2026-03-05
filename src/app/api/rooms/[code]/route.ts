import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;

  const room = await prisma.room.findUnique({
    where: { code },
    include: {
      songs: {
        where: { isPlayed: false },
        orderBy: [{ isPlaying: "desc" }, { sortOrder: "asc" }],
      },
      host: { select: { name: true, image: true } },
    },
  });

  if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });
  if (!room.isActive) return NextResponse.json({ error: "Room is closed" }, { status: 410 });

  return NextResponse.json(room);
}
