import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { startPlayback, pausePlayback, resumePlayback, getCurrentPlayback, addToQueue } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

export async function POST(
  req: NextRequest,
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

  // Check current Spotify playback state
  try {
    const playback = await getCurrentPlayback(accessToken);

    if (playback?.is_playing) {
      // Currently playing — pause it
      await pausePlayback(accessToken);
      return NextResponse.json({ success: true, action: "paused" });
    }

    // Not playing — check if we have a song queued
    const currentSong = await prisma.roomSong.findFirst({
      where: { roomId: room.id, isPlaying: true },
    });

    if (currentSong && playback?.item?.uri === currentSong.spotifyUri) {
      // Same song is loaded but paused — just resume
      await resumePlayback(accessToken);
      return NextResponse.json({ success: true, action: "resumed" });
    }

    // No current song or different song — start from queue
    let song = currentSong;
    if (!song) {
      song = await prisma.roomSong.findFirst({
        where: { roomId: room.id, isPlayed: false },
        orderBy: { sortOrder: "asc" },
      });
      if (song) {
        await prisma.roomSong.update({
          where: { id: song.id },
          data: { isPlaying: true },
        });
      }
    }

    if (!song) {
      return NextResponse.json({ error: "No songs in queue" }, { status: 404 });
    }

    await startPlayback(accessToken, [song.spotifyUri]);

    // Pre-queue the next song for gapless playback
    try {
      const nextSong = await prisma.roomSong.findFirst({
        where: { roomId: room.id, isPlayed: false, isPlaying: false, id: { not: song.id } },
        orderBy: { sortOrder: "asc" },
      });
      if (nextSong) {
        await addToQueue(accessToken, nextSong.spotifyUri);
      }
    } catch {
      // Best-effort
    }

    return NextResponse.json({ success: true, action: "playing", song });
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message || "Make sure Spotify is open on a device." },
      { status: 502 }
    );
  }
}
