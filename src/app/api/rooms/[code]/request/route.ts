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

  // Block replays of already-played songs (unless allowDuplicates is on)
  if (!room.allowDuplicates) {
    const alreadyPlayed = await prisma.roomSong.findFirst({
      where: { roomId: room.id, spotifyUri, isPlayed: true },
    });
    if (alreadyPlayed) {
      return NextResponse.json({ error: "This song has already been played" }, { status: 409 });
    }
  }

  // Check if song is already visible (in base display OR already requested)
  const displayLimit = room.queueDisplaySize || 50;
  const [baseSongs, requestedSongs] = await Promise.all([
    prisma.roomSong.findMany({
      where: { roomId: room.id, isPlayed: false, isRequested: false },
      orderBy: [{ isPlaying: "desc" }, { sortOrder: "asc" }],
      take: displayLimit,
      select: { id: true, spotifyUri: true },
    }),
    prisma.roomSong.findMany({
      where: { roomId: room.id, isPlayed: false, isRequested: true },
      select: { id: true, spotifyUri: true },
    }),
  ]);

  const visibleUris = new Set([...baseSongs, ...requestedSongs].map((s) => s.spotifyUri));
  if (visibleUris.has(spotifyUri)) {
    return NextResponse.json({ error: "Song already in queue" }, { status: 409 });
  }

  // Look up guest name
  const guest = await prisma.guest.findUnique({
    where: { roomId_fingerprint: { roomId: room.id, fingerprint } },
  });
  const guestName = guest?.name || "";

  // Check if this song exists beyond the display limit (pre-approved playlist song)
  const existingBeyond = await prisma.roomSong.findFirst({
    where: { roomId: room.id, spotifyUri, isPlayed: false },
  });

  if (room.requireApproval && !existingBeyond) {
    // Only require approval for brand new songs, not pre-approved playlist songs
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
  }

  if (existingBeyond) {
    // Bump the existing playlist song into the visible queue by marking it as requested
    await prisma.roomSong.update({
      where: { id: existingBeyond.id },
      data: { isRequested: true, addedBy: fingerprint, addedByName: guestName },
    });
    return NextResponse.json({ status: "added", song: existingBeyond, bumped: true });
  }

  // Brand new song — add to queue
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
      isRequested: true,
      addedBy: fingerprint,
      addedByName: guestName,
    },
  });
  return NextResponse.json({ status: "added", song });
}
