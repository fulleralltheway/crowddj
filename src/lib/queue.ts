import { prisma } from "@/lib/db";

/**
 * Get the next song to play, respecting autoShuffle.
 * When autoShuffle is on, picks the highest net-score unlocked song.
 * When off, picks the lowest sortOrder.
 * Locked songs are always prioritized (they were explicitly set as "up next").
 */
export async function getNextSong(roomId: string, autoShuffle: boolean) {
  // First check for a locked song (DJ lock or pre-queue lock) — always plays next
  const locked = await prisma.roomSong.findFirst({
    where: { roomId, isPlayed: false, isPlaying: false, isLocked: true },
    orderBy: { sortOrder: "asc" },
  });
  if (locked) return locked;

  if (autoShuffle) {
    // Sort by net score (upvotes - downvotes) descending, then sortOrder as tiebreaker
    const candidates = await prisma.roomSong.findMany({
      where: { roomId, isPlayed: false, isPlaying: false },
      orderBy: { sortOrder: "asc" },
    });
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const scoreA = a.upvotes - a.downvotes;
      const scoreB = b.upvotes - b.downvotes;
      if (scoreB !== scoreA) return scoreB - scoreA;
      return a.sortOrder - b.sortOrder;
    });
    return candidates[0];
  }

  // No autoShuffle — just use sortOrder
  return prisma.roomSong.findFirst({
    where: { roomId, isPlayed: false, isPlaying: false },
    orderBy: { sortOrder: "asc" },
  });
}
