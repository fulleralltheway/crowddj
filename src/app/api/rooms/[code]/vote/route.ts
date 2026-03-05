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

  // Get or create guest
  let guest = await prisma.guest.findUnique({
    where: { roomId_fingerprint: { roomId: room.id, fingerprint } },
  });

  if (!guest) {
    guest = await prisma.guest.create({
      data: { roomId: room.id, fingerprint },
    });
  }

  // Check vote reset
  const resetMs = room.voteResetMinutes * 60 * 1000;
  if (Date.now() - guest.lastVoteReset.getTime() > resetMs) {
    guest = await prisma.guest.update({
      where: { id: guest.id },
      data: { votesUsed: 0, lastVoteReset: new Date() },
    });
  }

  // Check existing vote on this song
  const existingVote = await prisma.vote.findUnique({
    where: { guestId_songId: { guestId: guest.id, songId } },
  });

  if (existingVote) {
    if (existingVote.value === value) {
      // Remove vote (toggle off)
      await prisma.vote.delete({ where: { id: existingVote.id } });
      await prisma.roomSong.update({
        where: { id: songId },
        data: value === 1 ? { upvotes: { decrement: 1 } } : { downvotes: { decrement: 1 } },
      });
      await prisma.guest.update({
        where: { id: guest.id },
        data: { votesUsed: { decrement: 1 } },
      });
    } else {
      // Change vote direction
      await prisma.vote.update({ where: { id: existingVote.id }, data: { value } });
      await prisma.roomSong.update({
        where: { id: songId },
        data:
          value === 1
            ? { upvotes: { increment: 1 }, downvotes: { decrement: 1 } }
            : { upvotes: { decrement: 1 }, downvotes: { increment: 1 } },
      });
      // No change in votesUsed since they already had a vote
    }
  } else {
    // Check vote limit
    if (guest.votesUsed >= room.votesPerUser) {
      return NextResponse.json({ error: "Vote limit reached" }, { status: 429 });
    }

    // Create new vote
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

  // Reorder songs based on votes (skip currently playing)
  const songs = await prisma.roomSong.findMany({
    where: { roomId: room.id, isPlayed: false, isPlaying: false },
    orderBy: { sortOrder: "asc" },
  });

  const sorted = songs.sort((a, b) => (b.upvotes - b.downvotes) - (a.upvotes - a.downvotes));

  // Find max sortOrder of playing songs to start after
  const playingSong = await prisma.roomSong.findFirst({
    where: { roomId: room.id, isPlaying: true },
  });
  const startOrder = playingSong ? playingSong.sortOrder + 1 : 0;

  await Promise.all(
    sorted.map((song, i) =>
      prisma.roomSong.update({
        where: { id: song.id },
        data: { sortOrder: startOrder + i },
      })
    )
  );

  return NextResponse.json({ success: true });
}
