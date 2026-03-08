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

  // Separate playing, locked, and unlocked
  const playing = withScore.filter((s) => s.isPlaying);
  const nonPlaying = withScore.filter((s) => !s.isPlaying);

  let sorted: typeof withScore;
  if (room.autoShuffle) {
    // Locked songs stay at their sortOrder-based positions; unlocked sort by netScore
    // First, sort all non-playing by sortOrder to establish positions
    nonPlaying.sort((a, b) => a.sortOrder - b.sortOrder);
    const locked = nonPlaying.filter((s) => s.isLocked);
    const unlocked = nonPlaying.filter((s) => !s.isLocked);
    unlocked.sort((a, b) => {
      if (b.netScore !== a.netScore) return b.netScore - a.netScore;
      return a.sortOrder - b.sortOrder;
    });

    // Rebuild: locked songs keep their relative positions, unlocked fill the gaps
    const lockedPositions = new Map<number, (typeof locked)[0]>();
    locked.forEach((s) => {
      lockedPositions.set(nonPlaying.indexOf(s), s);
    });
    const result: typeof withScore = [];
    let unlockedIdx = 0;
    for (let i = 0; i < nonPlaying.length; i++) {
      if (lockedPositions.has(i)) {
        result.push(lockedPositions.get(i)!);
      } else if (unlockedIdx < unlocked.length) {
        result.push(unlocked[unlockedIdx++]);
      }
    }
    sorted = [...playing, ...result];
  } else {
    nonPlaying.sort((a, b) => a.sortOrder - b.sortOrder);
    sorted = [...playing, ...nonPlaying];
  }

  return NextResponse.json(sorted);
}
