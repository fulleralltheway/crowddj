import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { startPlayback } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

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

  // Find currently playing song, or get the first unplayed song
  let song = await prisma.roomSong.findFirst({
    where: { roomId: room.id, isPlaying: true },
  });

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

  try {
    await startPlayback(accessToken, [song.spotifyUri]);
    return NextResponse.json({ success: true, song });
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message || "Failed to start playback. Make sure Spotify is open on a device." },
      { status: 502 }
    );
  }
}
