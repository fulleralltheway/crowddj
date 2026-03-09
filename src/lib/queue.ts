import { prisma } from "@/lib/db";

/**
 * Get the next song to play — uses the EXACT same ordering as the
 * songs display API so what the user sees at #1 is what plays next.
 */
export async function getNextSong(roomId: string, autoShuffle: boolean) {
  const candidates = await prisma.roomSong.findMany({
    where: { roomId, isPlayed: false, isPlaying: false },
    orderBy: { sortOrder: "asc" },
  });

  if (candidates.length === 0) return null;

  if (!autoShuffle) {
    // Simple sortOrder — first candidate is next
    return candidates[0];
  }

  // AutoShuffle: replicate the songs API display logic exactly
  // Locked songs stay at their sortOrder-based positions; unlocked sort by netScore
  const locked = candidates.filter((s) => s.isLocked);
  const unlocked = candidates.filter((s) => !s.isLocked);

  unlocked.sort((a, b) => {
    const scoreA = a.upvotes - a.downvotes;
    const scoreB = b.upvotes - b.downvotes;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.sortOrder - b.sortOrder;
  });

  // Rebuild: locked songs keep their relative positions, unlocked fill the gaps
  const lockedPositions = new Map<number, (typeof locked)[0]>();
  locked.forEach((s) => {
    lockedPositions.set(candidates.indexOf(s), s);
  });

  const result: typeof candidates = [];
  let unlockedIdx = 0;
  for (let i = 0; i < candidates.length; i++) {
    if (lockedPositions.has(i)) {
      result.push(lockedPositions.get(i)!);
    } else if (unlockedIdx < unlocked.length) {
      result.push(unlocked[unlockedIdx++]);
    }
  }

  return result[0] ?? null;
}
