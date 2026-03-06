import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

const ROOM_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;

  const room = await prisma.room.findUnique({
    where: { code },
    include: { host: { select: { name: true, image: true } } },
  });
  if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });

  const limit = room.queueDisplaySize || 50;

  // Base playlist songs (limited) + all guest-requested songs (always shown)
  const [baseSongs, requestedSongs] = await Promise.all([
    prisma.roomSong.findMany({
      where: { roomId: room.id, isPlayed: false, isRequested: false },
      orderBy: [{ isPlaying: "desc" }, { sortOrder: "asc" }],
      take: limit,
      include: { votes: { select: { guestId: true, value: true } } },
    }),
    prisma.roomSong.findMany({
      where: { roomId: room.id, isPlayed: false, isRequested: true },
      orderBy: [{ isPlaying: "desc" }, { sortOrder: "asc" }],
      include: { votes: { select: { guestId: true, value: true } } },
    }),
  ]);

  const seenIds = new Set(baseSongs.map((s) => s.id));
  const songs = [...baseSongs, ...requestedSongs.filter((s) => !seenIds.has(s.id))];
  songs.sort((a, b) => {
    if (a.isPlaying && !b.isPlaying) return -1;
    if (!a.isPlaying && b.isPlaying) return 1;
    return a.sortOrder - b.sortOrder;
  });

  // Auto-expire rooms older than 24 hours
  if (room.isActive && Date.now() - room.createdAt.getTime() > ROOM_EXPIRY_MS) {
    await prisma.room.update({
      where: { id: room.id },
      data: { isActive: false },
    });
    return NextResponse.json({ error: "Room has expired" }, { status: 410 });
  }

  if (!room.isActive) return NextResponse.json({ error: "Room is closed" }, { status: 410 });

  return NextResponse.json({ ...room, songs });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.hostId !== session.user.id) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const body = await req.json();
  const updates: any = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.votesPerUser !== undefined) updates.votesPerUser = Number(body.votesPerUser);
  if (body.voteResetMinutes !== undefined) updates.voteResetMinutes = Number(body.voteResetMinutes);
  if (body.requireApproval !== undefined) updates.requireApproval = Boolean(body.requireApproval);
  if (body.votingPaused !== undefined) updates.votingPaused = Boolean(body.votingPaused);
  if (body.maxSongsPerGuest !== undefined) updates.maxSongsPerGuest = Number(body.maxSongsPerGuest);
  if (body.explicitFilter !== undefined) updates.explicitFilter = Boolean(body.explicitFilter);
  if (body.autoShuffle !== undefined) updates.autoShuffle = Boolean(body.autoShuffle);
  if (body.queueDisplaySize !== undefined) updates.queueDisplaySize = Number(body.queueDisplaySize);

  const updated = await prisma.room.update({
    where: { id: room.id },
    data: updates,
  });

  return NextResponse.json(updated);
}

export async function DELETE(
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

  await prisma.room.update({
    where: { id: room.id },
    data: { isActive: false },
  });

  return NextResponse.json({ success: true });
}
