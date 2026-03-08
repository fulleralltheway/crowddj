import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const { fingerprint, name, guestId } = await req.json();

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

  if (!guest && guestId) {
    // Fingerprint changed but client has a stored guestId — try to reconcile
    const existingGuest = await prisma.guest.findFirst({
      where: { id: guestId, roomId: room.id },
    });
    if (existingGuest) {
      // Reassign the new fingerprint to the existing guest
      guest = await prisma.guest.update({
        where: { id: existingGuest.id },
        data: { fingerprint },
      });
    }
  }

  if (!guest) {
    // New guest in this room — check if this fingerprint OR guestId exists in ANY room to inherit identity
    let inheritedName = "";
    const fpGuest = await prisma.guest.findFirst({
      where: { fingerprint, name: { not: "" } },
      orderBy: { createdAt: "desc" },
    });
    if (fpGuest) {
      inheritedName = fpGuest.name;
    } else if (guestId) {
      const idGuest = await prisma.guest.findFirst({
        where: { id: guestId, name: { not: "" } },
      });
      if (idGuest) inheritedName = idGuest.name;
    }
    // Fall back to client-sent name only if no existing identity found
    guest = await prisma.guest.create({
      data: { roomId: room.id, fingerprint, name: inheritedName || name || "" },
    });
  } else if (name && !guest.name) {
    // Only set name if guest doesn't already have one (first time naming)
    guest = await prisma.guest.update({
      where: { id: guest.id },
      data: { name },
    });
  }
  // If guest already has a name, ignore any different name sent — enforce identity

  // Check vote reset — clear old votes so guest gets a fresh slate
  const resetMs = room.voteResetMinutes * 60 * 1000;
  if (Date.now() - guest.lastVoteReset.getTime() > resetMs) {
    await prisma.vote.deleteMany({ where: { guestId: guest.id } });
    guest = await prisma.guest.update({
      where: { id: guest.id },
      data: { votesUsed: 0, lastVoteReset: new Date() },
    });
  }

  // Derive votesUsed from actual Vote records (single source of truth)
  const actualVotesUsed = await prisma.vote.count({
    where: { guestId: guest.id },
  });

  // Fix drift: sync stored counter if it doesn't match reality
  if (guest.votesUsed !== actualVotesUsed) {
    await prisma.guest.update({
      where: { id: guest.id },
      data: { votesUsed: actualVotesUsed },
    });
  }

  // Update peak guest count if current count exceeds it
  const currentGuestCount = await prisma.guest.count({
    where: { roomId: room.id, name: { not: "" } },
  });
  if (currentGuestCount > room.peakGuestCount) {
    await prisma.room.update({
      where: { id: room.id },
      data: { peakGuestCount: currentGuestCount },
    });
  }

  return NextResponse.json({
    guestId: guest.id,
    votesUsed: actualVotesUsed,
    lastVoteReset: guest.lastVoteReset,
    name: guest.name,
  });
}
