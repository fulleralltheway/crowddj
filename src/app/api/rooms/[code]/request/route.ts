import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const { spotifyUri, trackName, artistName, albumArt, durationMs, fingerprint } = await req.json();

  if (!spotifyUri || !trackName || !fingerprint) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || !room.isActive) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }

  // Check if song already exists in room
  const existing = await prisma.roomSong.findFirst({
    where: { roomId: room.id, spotifyUri, isPlayed: false },
  });
  if (existing) {
    return NextResponse.json({ error: "Song already in queue" }, { status: 409 });
  }

  if (room.requireApproval) {
    // Create a pending request
    const request = await prisma.songRequest.create({
      data: {
        roomId: room.id,
        spotifyUri,
        trackName,
        artistName,
        albumArt,
        durationMs,
        requestedBy: fingerprint,
      },
    });
    return NextResponse.json({ status: "pending", request });
  } else {
    // Auto-add to queue
    const maxOrder = await prisma.roomSong.findFirst({
      where: { roomId: room.id },
      orderBy: { sortOrder: "desc" },
    });

    const song = await prisma.roomSong.create({
      data: {
        roomId: room.id,
        spotifyUri,
        trackName,
        artistName,
        albumArt,
        durationMs,
        sortOrder: (maxOrder?.sortOrder ?? -1) + 1,
        addedBy: fingerprint,
      },
    });
    return NextResponse.json({ status: "added", song });
  }
}
