import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getNextSong } from "@/lib/queue";
import { NextRequest, NextResponse } from "next/server";

/**
 * Lock the next unplayed song in the queue so the UI shows it as "up next"
 * before a fade/skip begins. Returns the locked song info.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.hostId !== session.user.id) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const nextSong = await getNextSong(room.id, room.autoShuffle);

  if (!nextSong) {
    return NextResponse.json({ success: true, song: null });
  }

  // Lock the song AND set lastPreQueuedId so the UI shows "Up Next" style
  // (votes visible but disabled) instead of DJ lock style (hides votes).
  // Also update lastSyncAdvance to signal "transition in progress" so the
  // cron's maxSongDuration handler backs off and doesn't race with the fade.
  if (!nextSong.isLocked) {
    await prisma.roomSong.update({
      where: { id: nextSong.id },
      data: { isLocked: true },
    });
  }
  await prisma.room.update({
    where: { id: room.id },
    data: { lastPreQueuedId: nextSong.id, lastSyncAdvance: new Date() },
  });

  return NextResponse.json({
    success: true,
    song: { id: nextSong.id, trackName: nextSong.trackName, artistName: nextSong.artistName },
  });
}
