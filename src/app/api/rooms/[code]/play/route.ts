import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { startPlayback, pausePlayback, resumePlayback, getCurrentPlayback, addToQueue, getDevices } from "@/lib/spotify";
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

    // If Spotify is currently playing the CrowdDJ song, pause it (toggle behavior)
    const currentSong = await prisma.roomSong.findFirst({
      where: { roomId: room.id, isPlaying: true },
    });

    if (playback?.is_playing && currentSong && playback?.item?.uri === currentSong.spotifyUri) {
      await pausePlayback(accessToken);
      return NextResponse.json({ success: true, action: "paused" });
    }

    // If CrowdDJ song is loaded but paused on Spotify — resume it
    if (!playback?.is_playing && currentSong && playback?.item?.uri === currentSong.spotifyUri) {
      await resumePlayback(accessToken);
      return NextResponse.json({ success: true, action: "resumed" });
    }

    // Otherwise, always start the CrowdDJ queue song explicitly
    // (Spotify might be playing its own content — we override it)
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

    // Start playback with the CrowdDJ song, overriding whatever Spotify had
    try {
      await startPlayback(accessToken, [song.spotifyUri]);
    } catch {
      // No active device — try to find one and play on it
      const devices = await getDevices(accessToken);
      if (devices.length === 0) {
        return NextResponse.json({
          error: "No Spotify devices found. Open Spotify on your phone, computer, or speaker and try again.",
          noDevice: true,
        }, { status: 502 });
      }
      // Pick the active device, or the first available one
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
    // Fallback — try to list devices for a helpful message
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
