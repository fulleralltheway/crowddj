/**
 * Pure helpers for the Bluegrass session queue.
 *
 * `getNextSessionTrack` is the workhorse — fade-skip and the cron-driven
 * fade-transition both call it instead of going to /v1/playlists/{id}/tracks
 * on every transition. With the (sessionId, isPlayed, sortOrder) index, this
 * is an O(1) lookup. See ADR 0002 for why this lives parallel to
 * src/lib/queue.ts's getNextSong instead of extending it.
 */

import { prisma } from "@/lib/db";

/** Return the next unplayed track for a session, or null if the queue is exhausted. */
export async function getNextSessionTrack(sessionId: string) {
  return prisma.bluegrassSessionTrack.findFirst({
    where: { sessionId, isPlayed: false },
    orderBy: { sortOrder: "asc" },
  });
}

/**
 * Mark the row whose `spotifyUri` matches `playedUri` as played + not playing.
 * Idempotent — if no row matches (e.g. Spotify advanced to a track outside the
 * imported queue), this is a no-op. Returns the count updated.
 */
export async function markCurrentPlayed(sessionId: string, playedUri: string): Promise<number> {
  const r = await prisma.bluegrassSessionTrack.updateMany({
    where: { sessionId, spotifyUri: playedUri, isPlayed: false },
    data: { isPlayed: true, isPlaying: false },
  });
  return r.count;
}

/**
 * Renumber a list of track ids so their sortOrder is contiguous starting at
 * `startAt`. Used by insert + remove flows to keep sortOrder gap-free.
 * Caller controls the order of `ids` — the function trusts it.
 */
export async function assignSortOrders(ids: string[], startAt = 0): Promise<void> {
  if (ids.length === 0) return;
  await prisma.$transaction(
    ids.map((id, i) =>
      prisma.bluegrassSessionTrack.update({
        where: { id },
        data: { sortOrder: startAt + i },
      })
    )
  );
}

/** True if the queue has at least one unplayed track. */
export async function hasUnplayed(sessionId: string): Promise<boolean> {
  const c = await prisma.bluegrassSessionTrack.count({
    where: { sessionId, isPlayed: false },
  });
  return c > 0;
}
