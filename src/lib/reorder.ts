import { prisma } from "@/lib/db";

/**
 * Re-sort visible songs by net vote score (respecting locked/pinned positions).
 * Pinned songs (DJ position lock) are placed at their pinnedPosition.
 * Other locked songs keep their sortOrder-based positions.
 * Only unlocked songs move — sorted by net score.
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

  songs.sort((a, b) => a.sortOrder - b.sortOrder);

  const unlocked = songs.filter((s) => !s.isLocked);
  if (unlocked.length === 0) return;

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

  // Build slot array: pinned songs get explicit positions, locked songs keep index
  const totalSlots = songs.length;
  const result: (typeof songs[0] | null)[] = new Array(totalSlots).fill(null);

  // 1) Place pinned songs at their explicit pinnedPosition
  const pinned = songs.filter((s) => s.isPinned && s.pinnedPosition != null);
  for (const s of pinned) {
    const idx = Math.max(0, Math.min(s.pinnedPosition!, totalSlots - 1));
    if (result[idx] === null) {
      result[idx] = s;
    } else {
      for (let d = 1; d < totalSlots; d++) {
        if (idx + d < totalSlots && result[idx + d] === null) { result[idx + d] = s; break; }
        if (idx - d >= 0 && result[idx - d] === null) { result[idx - d] = s; break; }
      }
    }
  }

  // 2) Place locked-not-pinned at their current sortOrder index
  const lockedNotPinned = songs.filter((s) => s.isLocked && !s.isPinned);
  lockedNotPinned.forEach((s) => {
    const idx = songs.indexOf(s);
    if (idx >= 0 && idx < totalSlots && result[idx] === null) {
      result[idx] = s;
    }
  });

  // 3) Fill remaining with sorted unlocked
  let unlockedIdx = 0;
  for (let i = 0; i < totalSlots; i++) {
    if (result[i] === null && unlockedIdx < sortedUnlocked.length) {
      result[i] = sortedUnlocked[unlockedIdx++];
    }
  }

  // Assign sortOrders — only update unlocked songs
  const updates: { id: string; newOrder: number }[] = [];
  for (let i = 0; i < totalSlots; i++) {
    const s = result[i];
    if (s && !s.isLocked) {
      const newOrder = startOrder + i;
      if (s.sortOrder !== newOrder) {
        updates.push({ id: s.id, newOrder });
      }
    }
  }

  if (updates.length === 0) return;

  await prisma.$transaction(
    updates.map(({ id, newOrder }) =>
      prisma.roomSong.update({
        where: { id },
        data: { sortOrder: newOrder },
      })
    )
  );
}
