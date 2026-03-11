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
  // Pinned songs (DJ position lock) go at pinnedPosition,
  // other locked songs keep sortOrder-based positions,
  // unlocked sort by netScore and fill gaps
  const pinned = candidates.filter((s) => s.isPinned && s.pinnedPosition != null);
  const lockedNotPinned = candidates.filter((s) => s.isLocked && !s.isPinned);
  const unlocked = candidates.filter((s) => !s.isLocked);

  unlocked.sort((a, b) => {
    const scoreA = a.upvotes - a.downvotes;
    const scoreB = b.upvotes - b.downvotes;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.sortOrder - b.sortOrder;
  });

  const totalSlots = candidates.length;
  const result: (typeof candidates[0] | null)[] = new Array(totalSlots).fill(null);

  // 1) Place pinned songs at their explicit positions
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

  // 2) Place locked-not-pinned at their sortOrder index
  lockedNotPinned.forEach((s) => {
    const idx = candidates.indexOf(s);
    if (idx >= 0 && idx < totalSlots && result[idx] === null) {
      result[idx] = s;
    }
  });

  // 3) Fill remaining with unlocked (sorted by netScore)
  let unlockedIdx = 0;
  for (let i = 0; i < totalSlots; i++) {
    if (result[i] === null && unlockedIdx < unlocked.length) {
      result[i] = unlocked[unlockedIdx++];
    }
  }

  return result.find((s) => s !== null) ?? null;
}
