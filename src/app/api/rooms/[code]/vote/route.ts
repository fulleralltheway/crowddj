import { prisma } from "@/lib/db";
import { reorderByVotes } from "@/lib/reorder";
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
      data: {
        votesUsed: { increment: 1 },
        ...(value === 1 ? { totalUpvotes: { increment: 1 } } : { totalDownvotes: { increment: 1 } }),
      },
    });
  }

  // Only reorder if autoShuffle is enabled
  if (room.autoShuffle) {
    await reorderByVotes(room.id, room.queueDisplaySize || 50);
  }

  // Return actual vote count so client stays in sync
  const actualVotesUsed = await prisma.vote.count({
    where: { guestId: guest.id },
  });

  // Fix drift
  if (guest.votesUsed !== actualVotesUsed) {
    await prisma.guest.update({
      where: { id: guest.id },
      data: { votesUsed: actualVotesUsed },
    });
  }

  return NextResponse.json({ success: true, action: oppositeVote ? "undo" : "vote", votesUsed: actualVotesUsed });
}
