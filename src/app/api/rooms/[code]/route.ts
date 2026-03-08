import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { reorderByVotes } from "@/lib/reorder";
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
  const hasTrack = { trackName: { not: "" } };
  const [baseSongs, requestedSongs] = await Promise.all([
    prisma.roomSong.findMany({
      where: { roomId: room.id, isPlayed: false, isRequested: false, ...hasTrack },
      orderBy: [{ isPlaying: "desc" }, { sortOrder: "asc" }],
      take: limit,
      include: { votes: { select: { guestId: true, value: true } } },
    }),
    prisma.roomSong.findMany({
      where: { roomId: room.id, isPlayed: false, isRequested: true, ...hasTrack },
      orderBy: [{ isPlaying: "desc" }, { sortOrder: "asc" }],
      include: { votes: { select: { guestId: true, value: true } } },
    }),
  ]);

  const seenIds = new Set(baseSongs.map((s) => s.id));
  const allSongs = [...baseSongs, ...requestedSongs.filter((s) => !seenIds.has(s.id))];
  const playing = allSongs.filter((s) => s.isPlaying);
  const nonPlaying = allSongs.filter((s) => !s.isPlaying);
  nonPlaying.sort((a, b) => a.sortOrder - b.sortOrder);

  let songs: typeof allSongs;
  if (room.autoShuffle) {
    const locked = nonPlaying.filter((s) => s.isLocked);
    const unlocked = nonPlaying.filter((s) => !s.isLocked);
    unlocked.sort((a, b) => {
      const scoreA = a.upvotes - a.downvotes;
      const scoreB = b.upvotes - b.downvotes;
      if (scoreB !== scoreA) return scoreB - scoreA;
      return a.sortOrder - b.sortOrder;
    });
    const lockedPositions = new Map<number, (typeof locked)[0]>();
    locked.forEach((s) => { lockedPositions.set(nonPlaying.indexOf(s), s); });
    const result: typeof allSongs = [];
    let ui = 0;
    for (let i = 0; i < nonPlaying.length; i++) {
      if (lockedPositions.has(i)) result.push(lockedPositions.get(i)!);
      else if (ui < unlocked.length) result.push(unlocked[ui++]);
    }
    songs = [...playing, ...result];
  } else {
    songs = [...playing, ...nonPlaying];
  }

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
  if (body.allowDuplicates !== undefined) updates.allowDuplicates = Boolean(body.allowDuplicates);
  if (body.maxSongDurationSec !== undefined) updates.maxSongDurationSec = Math.max(0, Math.min(600, Number(body.maxSongDurationSec)));
  if (body.blockedArtists !== undefined) updates.blockedArtists = String(body.blockedArtists);
  if (body.blockedSongs !== undefined) updates.blockedSongs = String(body.blockedSongs);

  const updated = await prisma.room.update({
    where: { id: room.id },
    data: updates,
  });

  // If autoShuffle was just turned ON, immediately re-sort the queue
  if (body.autoShuffle === true && !room.autoShuffle) {
    await reorderByVotes(room.id, updated.queueDisplaySize || 50);
  }

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
