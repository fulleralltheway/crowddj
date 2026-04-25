import { prisma } from "@/lib/db";
import { reorderByVotes } from "@/lib/reorder";
import { NextRequest, NextResponse } from "next/server";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const { songId, value, fingerprint, guestId: clientGuestId } = await req.json();

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

  // Get guest — try fingerprint first, then reconcile via guestId
  let guest = await prisma.guest.findUnique({
    where: { roomId_fingerprint: { roomId: room.id, fingerprint } },
  });

  if (!guest && clientGuestId) {
    // Fingerprint changed but client has a stored guestId — reconcile
    const existingGuest = await prisma.guest.findFirst({
      where: { id: clientGuestId, roomId: room.id },
    });
    if (existingGuest) {
      guest = await prisma.guest.update({
        where: { id: existingGuest.id },
        data: { fingerprint },
      });
    }
  }

  if (!guest) {
    guest = await prisma.guest.create({
      data: { roomId: room.id, fingerprint },
    });
  }

  // Check vote reset — clear old votes so guest gets a fresh slate
  // Before deleting, accumulate current votes into lifetime counters
  const resetMs = room.voteResetMinutes * 60 * 1000;
  if (Date.now() - guest.lastVoteReset.getTime() > resetMs) {
    const [upCount, downCount] = await Promise.all([
      prisma.vote.count({ where: { guestId: guest.id, value: 1 } }),
      prisma.vote.count({ where: { guestId: guest.id, value: -1 } }),
    ]);
    await prisma.vote.deleteMany({ where: { guestId: guest.id } });
    guest = await prisma.guest.update({
      where: { id: guest.id },
      data: {
        votesUsed: 0,
        lastVoteReset: new Date(),
        totalUpvotes: { increment: upCount },
        totalDownvotes: { increment: downCount },
      },
    });
  }

  // Check if song is locked
  const songRecord = await prisma.roomSong.findFirst({ where: { id: songId, roomId: room.id } });
  if (songRecord?.isLocked) {
    return NextResponse.json({ error: "This song is locked by the DJ" }, { status: 403 });
  }

  // Check if guest has an opposite vote on this song they can reclaim
  // e.g. downvoting when you have upvotes removes one upvote and refunds the vote
  const oppositeValue = value === 1 ? -1 : 1;
  const oppositeVote = await prisma.vote.findFirst({
    where: { guestId: guest.id, songId, value: oppositeValue },
  });

  let action: "reclaim" | "vote";

  if (oppositeVote) {
    // Opposite vote exists — remove one, refund the vote
    action = "reclaim";
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
    // No opposite vote — this is a new vote, check limit
    action = "vote";
    const currentVoteCount = await prisma.vote.count({
      where: { guestId: guest.id },
    });
    if (currentVoteCount >= room.votesPerUser) {
      return NextResponse.json({ error: "Vote limit reached", votesUsed: currentVoteCount }, { status: 429 });
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
    // Increment room vote stats
    await prisma.room.update({
      where: { id: room.id },
      data: { totalVotesCast: { increment: 1 } },
    });
  }

  // Only reorder if autoShuffle is enabled. Skip while a drag is in flight to
  // prevent the host's chosen position from getting bumped by vote-driven sort.
  // The vote itself is already persisted above; only the resort is suppressed.
  if (room.autoShuffle && !room.dragInFlight) {
    await reorderByVotes(room.id, room.queueDisplaySize || 50);
  } else if (room.autoShuffle && room.dragInFlight) {
    console.log(`[${code}] Suppressing reorderByVotes: dragInFlight=true`);
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

  return NextResponse.json({ success: true, action, votesUsed: actualVotesUsed });
}
