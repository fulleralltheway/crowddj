import { prisma } from "@/lib/db";
import { getCurrentPlayback, startPlayback } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

async function getAccessToken(account: any) {
  let accessToken = account.access_token;

  if (account.expires_at && account.expires_at * 1000 < Date.now()) {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(
          `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
        ).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: account.refresh_token!,
      }),
    });
    const tokens = await res.json();
    if (!res.ok) return null;

    accessToken = tokens.access_token;
    await prisma.account.update({
      where: { id: account.id },
      data: {
        access_token: tokens.access_token,
        expires_at: Math.floor(Date.now() / 1000 + tokens.expires_in),
        refresh_token: tokens.refresh_token ?? account.refresh_token,
      },
    });
  }

  return accessToken;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || !room.isActive) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }

  const account = await prisma.account.findFirst({
    where: { userId: room.hostId, provider: "spotify" },
  });
  if (!account?.access_token) {
    return NextResponse.json({ synced: false });
  }

  const accessToken = await getAccessToken(account).catch(() => null);
  if (!accessToken) {
    return NextResponse.json({ synced: false });
  }

  const currentSong = await prisma.roomSong.findFirst({
    where: { roomId: room.id, isPlaying: true },
  });

  if (!currentSong) {
    return NextResponse.json({ synced: true, playing: false });
  }

  try {
    const playback = await getCurrentPlayback(accessToken);

    // Determine if we should advance to the next song
    let shouldAdvance = false;

    if (!playback) {
      // No playback state at all — player closed or song ended
      shouldAdvance = true;
    } else if (!playback.item) {
      // Playback object exists but no track — idle state after song ended
      shouldAdvance = true;
    } else if (playback.item.uri === currentSong.spotifyUri) {
      // Our track is loaded — check if it finished
      if (!playback.is_playing && playback.progress_ms > playback.item.duration_ms - 3000) {
        shouldAdvance = true;
      }
      // Also catch when progress is 0 and not playing (Spotify resets after track ends)
      if (!playback.is_playing && playback.progress_ms === 0 && playback.item.duration_ms > 0) {
        shouldAdvance = true;
      }
    } else if (playback.item.uri !== currentSong.spotifyUri) {
      // Spotify is playing a different track — user changed songs externally
      // Just clear our "now playing" without auto-advancing (don't fight the user)
      await prisma.roomSong.update({
        where: { id: currentSong.id },
        data: { isPlaying: false },
      });
      return NextResponse.json({ synced: true, playing: false, externalOverride: true });
    }

    if (shouldAdvance) {
      await prisma.roomSong.update({
        where: { id: currentSong.id },
        data: { isPlaying: false, isPlayed: true },
      });

      const nextSong = await prisma.roomSong.findFirst({
        where: { roomId: room.id, isPlayed: false, isPlaying: false },
        orderBy: { sortOrder: "asc" },
      });

      if (nextSong) {
        await prisma.roomSong.update({
          where: { id: nextSong.id },
          data: { isPlaying: true },
        });

        try {
          await startPlayback(accessToken, [nextSong.spotifyUri]);
        } catch {
          // Device might not be available
        }

        return NextResponse.json({ synced: true, advanced: true, song: nextSong.trackName });
      }

      return NextResponse.json({ synced: true, queueEmpty: true });
    }

    return NextResponse.json({ synced: true, playing: true, spotifyPlaying: !!playback?.is_playing });
  } catch {
    return NextResponse.json({ synced: false });
  }
}
