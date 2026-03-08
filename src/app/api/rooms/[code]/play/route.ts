import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { startPlayback, pausePlayback, resumePlayback, getCurrentPlayback, getDevices } from "@/lib/spotify";
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

  try {
    const playback = await getCurrentPlayback(accessToken);

    const currentSong = await prisma.roomSong.findFirst({
      where: { roomId: room.id, isPlaying: true },
    });

    // If Spotify is playing our song, pause it (toggle)
    if (playback?.is_playing && currentSong && playback?.item?.uri === currentSong.spotifyUri) {
      await pausePlayback(accessToken);
      return NextResponse.json({ success: true, action: "paused" });
    }

    // If our song is loaded but paused — resume
    if (!playback?.is_playing && currentSong && playback?.item?.uri === currentSong.spotifyUri) {
      await resumePlayback(accessToken);
      return NextResponse.json({ success: true, action: "resumed" });
    }

    // Otherwise, start the current queue song
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

    // Play this song
    try {
      await startPlayback(accessToken, [song.spotifyUri]);
    } catch {
      const devices = await getDevices(accessToken);
      if (devices.length === 0) {
        return NextResponse.json({
          error: "No Spotify devices found. Open Spotify on your phone, computer, or speaker and try again.",
          noDevice: true,
        }, { status: 502 });
      }
      const target = devices.find((d: any) => d.is_active) || devices[0];
      try {
        await startPlayback(accessToken, [song.spotifyUri], target.id);
      } catch (e2: any) {
        return NextResponse.json({
          error: `Couldn't play on ${target.name}. Make sure Spotify is unlocked and ready.`,
          devices: devices.map((d: any) => ({ name: d.name, type: d.type })),
        }, { status: 502 });
      }
    }

    // Next song will be queued by the cron when ~20s remain (to allow voting until then)
    await prisma.room.update({ where: { id: room.id }, data: { lastPreQueuedId: null } });

    return NextResponse.json({ success: true, action: "playing", song });
  } catch (e: any) {
    try {
      const devices = await getDevices(accessToken);
      if (devices.length === 0) {
        return NextResponse.json({
          error: "No Spotify devices found. Open Spotify on your phone, computer, or speaker and try again.",
          noDevice: true,
        }, { status: 502 });
      }
      return NextResponse.json({
        error: `Playback failed. Available devices: ${devices.map((d: any) => d.name).join(", ")}. Make sure one is active.`,
        devices: devices.map((d: any) => ({ name: d.name, type: d.type })),
      }, { status: 502 });
    } catch {
      return NextResponse.json(
        { error: "Open Spotify on a device and try again." },
        { status: 502 }
      );
    }
  }
}
