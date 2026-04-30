import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { assignSortOrders } from "@/lib/bluegrass-queue";
import { NextRequest, NextResponse } from "next/server";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; trackId: string }> }
) {
  const auth_ = await auth();
  if (!auth_?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id, trackId } = await params;

  const sess = await prisma.bluegrassSession.findUnique({
    where: { id },
    select: { id: true, userId: true, isActive: true },
  });
  if (!sess || sess.userId !== auth_.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const track = await prisma.bluegrassSessionTrack.findUnique({
    where: { id: trackId },
    select: { id: true, sessionId: true, isPlayed: true, isPlaying: true },
  });
  if (!track || track.sessionId !== id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (track.isPlaying) {
    return NextResponse.json({ error: "currently_playing" }, { status: 409 });
  }
  if (track.isPlayed) {
    return NextResponse.json({ error: "already_played" }, { status: 404 });
  }

  await prisma.bluegrassSessionTrack.delete({ where: { id: trackId } });

  // Renumber remaining unplayed tracks contiguously after the played-tail.
  const remaining = await prisma.bluegrassSessionTrack.findMany({
    where: { sessionId: id, isPlayed: false },
    orderBy: { sortOrder: "asc" },
    select: { id: true },
  });
  const lastPlayed = await prisma.bluegrassSessionTrack.findFirst({
    where: { sessionId: id, isPlayed: true },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  await assignSortOrders(
    remaining.map((t) => t.id),
    (lastPlayed?.sortOrder ?? -1) + 1
  );

  return NextResponse.json({ removed: true });
}
