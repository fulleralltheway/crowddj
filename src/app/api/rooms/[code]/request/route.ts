import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const { spotifyUri, trackName, artistName, albumArt, durationMs, fingerprint, isExplicit } = await req.json();

  if (!spotifyUri || !trackName || !fingerprint) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || !room.isActive) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }

  // Explicit filter
  if (room.explicitFilter && isExplicit) {
    return NextResponse.json({ error: "Explicit songs are not allowed in this room" }, { status: 403 });
  }

  // Max songs per guest
  if (room.maxSongsPerGuest > 0) {
    const guestSongCount = await prisma.roomSong.count({
      where: { roomId: room.id, addedBy: fingerprint, isPlayed: false },
    });
    if (guestSongCount >= room.maxSongsPerGuest) {
      return NextResponse.json({ error: `You can only add ${room.maxSongsPerGuest} songs` }, { status: 429 });
    }
  }

  // Check if song already exists in room
  const existing = await prisma.roomSong.findFirst({
    where: { roomId: room.id, spotifyUri, isPlayed: false },
  });
  if (existing) {
    return NextResponse.json({ error: "Song already in queue" }, { status: 409 });
  }

  // Look up guest name
  const guest = await prisma.guest.findUnique({
    where: { roomId_fingerprint: { roomId: room.id, fingerprint } },
  });
  const guestName = guest?.name || "";

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
        requestedByName: guestName,
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
        addedByName: guestName,
      },
    });
    return NextResponse.json({ status: "added", song });
  }
}
