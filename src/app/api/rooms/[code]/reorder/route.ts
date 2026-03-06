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

  const body = await req.json();

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.hostId !== session.user.id) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  // Accept a full ordered list of song IDs
  const { orderedIds } = body as { orderedIds: string[] };
  if (!orderedIds || !Array.isArray(orderedIds) || orderedIds.length === 0) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // Get the playing song's sortOrder as baseline
  const playingSong = await prisma.roomSong.findFirst({
    where: { roomId: room.id, isPlaying: true },
  });
  const startOrder = playingSong ? playingSong.sortOrder + 1 : 0;

  // Update all songs with new sort orders
  await Promise.all(
    orderedIds.map((id, i) =>
      prisma.roomSong.update({
        where: { id },
        data: { sortOrder: startOrder + i },
      })
    )
  );

  return NextResponse.json({ success: true });
}
