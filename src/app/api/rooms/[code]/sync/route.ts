import { prisma } from "@/lib/db";
import { getCurrentPlayback, startPlayback, addToQueue } from "@/lib/spotify";
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

    if (!playback || !playback.item) {
      // No playback state or no track — Spotify is idle/closed
      // Just clear our "now playing" — don't auto-advance (host can hit Play to resume)
      await prisma.roomSong.update({
        where: { id: currentSong.id },
        data: { isPlaying: false },
      });
      return NextResponse.json({ synced: true, playing: false, reason: "no_playback" });
    }

    if (playback.item.uri !== currentSong.spotifyUri) {
      // Spotify is playing a different track — check if it's the next CrowdDJ song
      // (this happens when Spotify auto-advanced via the pre-queued track)
      const nextCrowdDJSong = await prisma.roomSong.findFirst({
        where: { roomId: room.id, isPlayed: false, isPlaying: false },
        orderBy: { sortOrder: "asc" },
      });

      if (nextCrowdDJSong && playback.item.uri === nextCrowdDJSong.spotifyUri && playback.is_playing) {
        // Spotify auto-advanced to our next song — update DB to match
        const timeSinceLastAdvance = Date.now() - room.lastSyncAdvance.getTime();
        if (timeSinceLastAdvance < 10000) {
          return NextResponse.json({ synced: true, playing: true, reason: "debounced" });
        }

        await prisma.room.update({
          where: { id: room.id },
          data: { lastSyncAdvance: new Date() },
        });
        await prisma.roomSong.update({
          where: { id: currentSong.id },
          data: { isPlaying: false, isPlayed: true },
        });
        await prisma.roomSong.update({
          where: { id: nextCrowdDJSong.id },
          data: { isPlaying: true },
        });

        // Pre-queue the song after that
        await queueNextSong(room.id, nextCrowdDJSong.id, accessToken);

        return NextResponse.json({ synced: true, advanced: true, song: nextCrowdDJSong.trackName });
      }

      // Truly external content — clear our "now playing"
      await prisma.roomSong.update({
        where: { id: currentSong.id },
        data: { isPlaying: false },
      });
      return NextResponse.json({ synced: true, playing: false, reason: "external_override" });
    }

    // Our track is loaded — check if it finished
    const isFinished =
      (!playback.is_playing && playback.progress_ms > playback.item.duration_ms - 3000) ||
      (!playback.is_playing && playback.progress_ms === 0 && playback.item.duration_ms > 0);

    if (isFinished) {
      // Debounce: don't advance if another sync already did within the last 10 seconds
      const timeSinceLastAdvance = Date.now() - room.lastSyncAdvance.getTime();
      if (timeSinceLastAdvance < 10000) {
        return NextResponse.json({ synced: true, playing: false, reason: "debounced" });
      }

      // Claim the advance by updating the timestamp
      await prisma.room.update({
        where: { id: room.id },
        data: { lastSyncAdvance: new Date() },
      });

      // Mark current song as played
      await prisma.roomSong.update({
        where: { id: currentSong.id },
        data: { isPlaying: false, isPlayed: true },
      });

      // Find and play the next song
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
          // Queue the song after that for gapless playback
          await queueNextSong(room.id, nextSong.id, accessToken);
        } catch {
          // Device might not be available
        }

        return NextResponse.json({ synced: true, advanced: true, song: nextSong.trackName });
      }

      return NextResponse.json({ synced: true, queueEmpty: true });
    }

    // Song is still playing — check if we should pre-queue the next song
    // Wide window (45s) so cron pings reliably catch it; Spotify ignores duplicate queue adds
    const remaining = playback.item.duration_ms - playback.progress_ms;
    if (playback.is_playing && remaining < 45000 && remaining > 5000) {
      await queueNextSong(room.id, currentSong.id, accessToken);
    }

    return NextResponse.json({ synced: true, playing: true, spotifyPlaying: !!playback.is_playing });
  } catch {
    return NextResponse.json({ synced: false });
  }
}

async function queueNextSong(roomId: string, currentSongId: string, accessToken: string) {
  try {
    const nextSong = await prisma.roomSong.findFirst({
      where: { roomId, isPlayed: false, isPlaying: false, id: { not: currentSongId } },
      orderBy: { sortOrder: "asc" },
    });
    if (nextSong) {
      await addToQueue(accessToken, nextSong.spotifyUri);
    }
  } catch {
    // Silently fail — queuing is best-effort
  }
}
