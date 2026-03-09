import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getNextSong } from "@/lib/queue";
import { startPlayback, skipToNext, getCurrentPlayback, setVolume, pausePlayback } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const accessToken = (session as any).accessToken;
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.hostId !== session.user.id) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  // Mark current song as played
  const playing = await prisma.roomSong.findFirst({
    where: { roomId: room.id, isPlaying: true },
  });

  if (playing) {
    await prisma.roomSong.update({
      where: { id: playing.id },
      data: { isPlaying: false, isPlayed: true },
    });
  }

  // Set next song as playing (respects autoShuffle vote-based ordering)
  const nextSong = await getNextSong(room.id, room.autoShuffle);

  if (nextSong) {
    // Unlock it (may have been locked as "queued next") and set as playing
    await prisma.roomSong.update({
      where: { id: nextSong.id },
      data: { isPlaying: true, isLocked: false },
    });

    // Ensure volume is audible before skipping (may have been faded to 0)
    try {
      const playback = await getCurrentPlayback(accessToken);
      const currentVol = playback?.device?.volume_percent ?? 100;
      if (currentVol < 20) {
        await setVolume(accessToken, 65);
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch {}

    // If this song was already pre-queued into Spotify's queue, use skipToNext
    // to consume it. Otherwise startPlayback would leave an orphaned copy in the
    // queue that would replay the song when it finishes.
    const wasPreQueued = room.lastPreQueuedId === nextSong.id;
    try {
      if (wasPreQueued) {
        await skipToNext(accessToken);
      } else {
        await startPlayback(accessToken, [nextSong.spotifyUri]);
      }
    } catch {
      // Try the other method as fallback
      try {
        if (wasPreQueued) {
          await startPlayback(accessToken, [nextSong.spotifyUri]);
        } else {
          await skipToNext(accessToken);
        }
      } catch {}
    }

    // Update room: clear pre-queue, debounce cron, track stats
    await prisma.room.update({
      where: { id: room.id },
      data: {
        lastPreQueuedId: null,
        lastSyncAdvance: new Date(),
        totalSongsPlayed: { increment: 1 },
      },
    });
  } else {
    // No more songs — pause Spotify so it doesn't auto-play random music
    try { await pausePlayback(accessToken); } catch {}
    await prisma.room.update({
      where: { id: room.id },
      data: { lastPreQueuedId: null, lastSyncAdvance: new Date() },
    });
  }

  return NextResponse.json({ success: true, song: nextSong });
}
