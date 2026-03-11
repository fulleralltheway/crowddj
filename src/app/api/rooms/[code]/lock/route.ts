import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { reorderByVotes } from "@/lib/reorder";
import { NextRequest, NextResponse } from "next/server";

// Position-based lock reorders all queue songs — can be slow for large queues
export const maxDuration = 30;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { songId, forceLock, position } = await req.json();
  if (!songId) return NextResponse.json({ error: "Missing songId" }, { status: 400 });

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.hostId !== session.user.id) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const song = await prisma.roomSong.findFirst({
    where: { id: songId, roomId: room.id },
  });
  if (!song) return NextResponse.json({ error: "Song not found" }, { status: 404 });

  const newLocked = forceLock === true ? true : !song.isLocked;

  // When locking at a specific position, move the song there in one atomic operation
  if (newLocked && position != null) {
    // Get all queue songs (non-playing, non-played) in current order
    const queueSongs = await prisma.roomSong.findMany({
      where: { roomId: room.id, isPlayed: false, isPlaying: false },
      orderBy: { sortOrder: "asc" },
    });

    // Remove the target song from the list
    const without = queueSongs.filter((s) => s.id !== songId);
    const targetIdx = Math.max(0, Math.min(position, without.length));
    // Insert at the desired position
    without.splice(targetIdx, 0, song);

    // Only update songs whose sortOrder actually changed (+ always update target for lock fields)
    const updates = without
      .map((s, i) => ({ song: s, newOrder: i }))
      .filter(({ song: s, newOrder }) => s.sortOrder !== newOrder || s.id === songId);

    await prisma.$transaction(
      updates.map(({ song: s, newOrder }) =>
        prisma.roomSong.update({
          where: { id: s.id },
          data: {
            sortOrder: newOrder,
            ...(s.id === songId ? {
              isLocked: true,
              isPinned: true,
              pinnedPosition: position,
            } : {}),
          },
        })
      )
    );

    // Verify the lock persisted
    const verify = await prisma.roomSong.findFirst({ where: { id: songId } });
    console.log(`[Lock] Position lock: song=${songId} pos=${targetIdx} locked=${verify?.isLocked} sortOrder=${verify?.sortOrder} updates=${updates.length}/${without.length}`);

    return NextResponse.json({ success: true, locked: true, position: targetIdx, verified: verify?.isLocked });
  }

  // Simple lock toggle (no position)
  await prisma.roomSong.update({
    where: { id: songId },
    data: {
      isLocked: newLocked,
      isPinned: false,
      pinnedPosition: null,
    },
  });

  // Verify
  const verify = await prisma.roomSong.findFirst({ where: { id: songId } });
  console.log(`[Lock] Simple toggle: song=${songId} locked=${verify?.isLocked}`);

  // Re-sort on unlock (song needs to find its vote-based position)
  // Skip on forceLock (triggered by drag — order was already set by reorder endpoint)
  if (room.autoShuffle && !newLocked && !forceLock) {
    await reorderByVotes(room.id, room.queueDisplaySize || 50);
  }

  return NextResponse.json({ success: true, locked: newLocked, verified: verify?.isLocked });
}
