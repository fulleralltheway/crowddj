import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });

  const limit = room.queueDisplaySize || 50;

  // Base playlist songs (limited) + all guest-requested songs (always shown)
  // Exclude songs with missing track info (blank entries)
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

  // Merge and deduplicate (requested songs may overlap with base if within limit)
  const seenIds = new Set(baseSongs.map((s) => s.id));
  const merged = [...baseSongs, ...requestedSongs.filter((s) => !seenIds.has(s.id))];

  const withScore = merged.map((s) => ({
    ...s,
    netScore: s.upvotes - s.downvotes,
  }));

  // Sort: playing first, then locked songs by sortOrder, then by netScore (if autoShuffle) or sortOrder
  withScore.sort((a, b) => {
    if (a.isPlaying && !b.isPlaying) return -1;
    if (!a.isPlaying && b.isPlaying) return 1;
    // Locked songs always keep their sortOrder position
    if (a.isLocked && !b.isLocked) return -1;
    if (!a.isLocked && b.isLocked) return 1;
    if (a.isLocked && b.isLocked) return a.sortOrder - b.sortOrder;
    // Unlocked: sort by netScore descending when autoShuffle, else sortOrder
    if (room.autoShuffle) {
      if (b.netScore !== a.netScore) return b.netScore - a.netScore;
      return a.sortOrder - b.sortOrder; // tie-break by original order
    }
    return a.sortOrder - b.sortOrder;
  });

  const sorted = withScore;

  return NextResponse.json(sorted);
}
