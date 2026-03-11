import { prisma } from "@/lib/db";

/**
 * Re-sort visible songs by net vote score (respecting locked positions).
 * Locked songs keep their exact positions — only unlocked songs move.
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

  // Sort by sortOrder so positions are consistent
  songs.sort((a, b) => a.sortOrder - b.sortOrder);

  const locked = songs.filter((s) => s.isLocked);
  const unlocked = songs.filter((s) => !s.isLocked);

  if (unlocked.length === 0) return; // Nothing to reorder

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

  // Record which array indices are locked
  const lockedIndices = new Set<number>();
  locked.forEach((s) => {
    lockedIndices.add(songs.indexOf(s));
  });

  // Build merged array: locked songs keep their index, unlocked fill gaps
  const merged: typeof songs = [];
  let unlockedIdx = 0;
  for (let i = 0; i < songs.length; i++) {
    if (lockedIndices.has(i)) {
      merged.push(songs[i]); // Keep locked song at its index
    } else if (unlockedIdx < sortedUnlocked.length) {
      merged.push(sortedUnlocked[unlockedIdx++]);
    }
  }

  // Only update UNLOCKED songs — locked songs keep their exact sortOrder
  const updates = merged
    .map((song, i) => ({ song, newOrder: startOrder + i }))
    .filter(({ song }) => !song.isLocked);

  if (updates.length === 0) return;

  await prisma.$transaction(
    updates.map(({ song, newOrder }) =>
      prisma.roomSong.update({
        where: { id: song.id },
        data: { sortOrder: newOrder },
      })
    )
  );
}
