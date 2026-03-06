import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const { songId, value, fingerprint } = await req.json();

  if (!songId || !fingerprint || (value !== 1 && value !== -1)) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || !room.isActive) {
    return NextResponse.json({ error: "Room not found or inactive" }, { status: 404 });
  }

  if (room.votingPaused) {
    return NextResponse.json({ error: "Voting is paused by the DJ" }, { status: 403 });
  }

  // Get or create guest
  let guest = await prisma.guest.findUnique({
    where: { roomId_fingerprint: { roomId: room.id, fingerprint } },
  });

  if (!guest) {
    guest = await prisma.guest.create({
      data: { roomId: room.id, fingerprint },
    });
  }

  // Check vote reset — clear old votes so guest gets a fresh slate
  const resetMs = room.voteResetMinutes * 60 * 1000;
  if (Date.now() - guest.lastVoteReset.getTime() > resetMs) {
    await prisma.vote.deleteMany({ where: { guestId: guest.id } });
    guest = await prisma.guest.update({
      where: { id: guest.id },
      data: { votesUsed: 0, lastVoteReset: new Date() },
    });
  }

  // Check if song is locked
  const songRecord = await prisma.roomSong.findFirst({ where: { id: songId, roomId: room.id } });
  if (songRecord?.isLocked) {
    return NextResponse.json({ error: "This song is locked by the DJ" }, { status: 403 });
  }

  // Check if guest has an opposite vote on this song they can undo
  const oppositeValue = value === 1 ? -1 : 1;
  const oppositeVote = await prisma.vote.findFirst({
    where: { guestId: guest.id, songId, value: oppositeValue },
  });

  if (oppositeVote) {
    // Undo the opposite vote — delete it, update song counts, refund the vote
    await prisma.vote.delete({ where: { id: oppositeVote.id } });
    await prisma.roomSong.update({
      where: { id: songId },
      data: oppositeValue === 1
        ? { upvotes: { decrement: 1 } }
        : { downvotes: { decrement: 1 } },
    });
    await prisma.guest.update({
      where: { id: guest.id },
      data: { votesUsed: { decrement: 1 } },
    });
  } else {
    // No opposite vote to undo — this is a new vote, check limit
    if (guest.votesUsed >= room.votesPerUser) {
      return NextResponse.json({ error: "Vote limit reached" }, { status: 429 });
    }

    // Create the vote
    await prisma.vote.create({
      data: { guestId: guest.id, songId, value },
    });
    await prisma.roomSong.update({
      where: { id: songId },
      data: value === 1 ? { upvotes: { increment: 1 } } : { downvotes: { increment: 1 } },
    });
    await prisma.guest.update({
      where: { id: guest.id },
      data: { votesUsed: { increment: 1 } },
    });
  }

  // Reorder songs based on votes (skip playing and locked songs)
  const songs = await prisma.roomSong.findMany({
    where: { roomId: room.id, isPlayed: false, isPlaying: false },
    orderBy: { sortOrder: "asc" },
  });

  const locked = songs.filter((s) => s.isLocked);
  const unlocked = songs.filter((s) => !s.isLocked);
  const sortedUnlocked = unlocked.sort((a, b) => (b.upvotes - b.downvotes) - (a.upvotes - a.downvotes));

  const playingSong = await prisma.roomSong.findFirst({
    where: { roomId: room.id, isPlaying: true },
  });
  const startOrder = playingSong ? playingSong.sortOrder + 1 : 0;

  // Build final order: locked songs keep their positions, unlocked fill around them
  // First, assign locked songs their current relative positions
  const lockedPositions = new Map<number, typeof locked[0]>();
  locked.forEach((s) => {
    const relPos = songs.indexOf(s);
    lockedPositions.set(relPos, s);
  });

  // Merge: place locked songs at their positions, fill gaps with sorted unlocked
  const merged: typeof songs = [];
  let unlockedIdx = 0;
  for (let i = 0; i < songs.length; i++) {
    if (lockedPositions.has(i)) {
      merged.push(lockedPositions.get(i)!);
    } else if (unlockedIdx < sortedUnlocked.length) {
      merged.push(sortedUnlocked[unlockedIdx++]);
    }
  }

  await Promise.all(
    merged.map((song, i) =>
      prisma.roomSong.update({
        where: { id: song.id },
        data: { sortOrder: startOrder + i },
      })
    )
  );

  return NextResponse.json({ success: true, action: oppositeVote ? "undo" : "vote" });
}
