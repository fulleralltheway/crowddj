import { prisma } from "@/lib/db";

/**
 * Re-sort visible songs by net vote score (respecting locked positions).
 * Only touches visible songs (display limit + requested), not the full queue.
 */
export async function reorderByVotes(roomId: string, displayLimit: number) {
  const [baseSongs, requestedSongs] = await Promise.all([
    prisma.roomSong.findMany({
      where: { roomId, isPlayed: false, isPlaying: false, isRequested: false },
      orderBy: { sortOrder: "asc" },
      take: displayLimit,
    }),
    prisma.roomSong.findMany({
      where: { roomId, isPlayed: false, isPlaying: false, isRequested: true },
      orderBy: { sortOrder: "asc" },
    }),
  ]);

  const seenIds = new Set(baseSongs.map((s) => s.id));
  const songs = [...baseSongs, ...requestedSongs.filter((s) => !seenIds.has(s.id))];

  if (songs.length === 0) return;

  const locked = songs.filter((s) => s.isLocked);
  const unlocked = songs.filter((s) => !s.isLocked);
  const sortedUnlocked = unlocked.sort((a, b) => {
    const scoreA = a.upvotes - a.downvotes;
    const scoreB = b.upvotes - b.downvotes;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.sortOrder - b.sortOrder;
  });

  const playingSong = await prisma.roomSong.findFirst({
    where: { roomId, isPlaying: true },
  });
  const startOrder = playingSong ? playingSong.sortOrder + 1 : 0;

  const lockedPositions = new Map<number, (typeof locked)[0]>();
  locked.forEach((s) => {
    const relPos = songs.indexOf(s);
    lockedPositions.set(relPos, s);
  });

  const merged: typeof songs = [];
  let unlockedIdx = 0;
  for (let i = 0; i < songs.length; i++) {
    if (lockedPositions.has(i)) {
      merged.push(lockedPositions.get(i)!);
    } else if (unlockedIdx < sortedUnlocked.length) {
      merged.push(sortedUnlocked[unlockedIdx++]);
    }
  }

  await prisma.$transaction(
    merged.map((song, i) =>
      prisma.roomSong.update({
        where: { id: song.id },
        data: { sortOrder: startOrder + i },
      })
    )
  );
}
