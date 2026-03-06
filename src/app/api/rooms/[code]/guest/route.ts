import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const { fingerprint, name } = await req.json();

  if (!fingerprint) {
    return NextResponse.json({ error: "Missing fingerprint" }, { status: 400 });
  }

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || !room.isActive) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }

  // Get or create guest
  let guest = await prisma.guest.findUnique({
    where: { roomId_fingerprint: { roomId: room.id, fingerprint } },
  });

  if (!guest) {
    guest = await prisma.guest.create({
      data: { roomId: room.id, fingerprint, name: name || "" },
    });
  } else if (name && name !== guest.name) {
    // Update name if provided and different
    guest = await prisma.guest.update({
      where: { id: guest.id },
      data: { name },
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

  return NextResponse.json({
    guestId: guest.id,
    votesUsed: guest.votesUsed,
    lastVoteReset: guest.lastVoteReset,
    name: guest.name,
  });
}
