import { prisma } from "@/lib/db";
import { getCurrentPlayback, startPlayback, addToQueue } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30; // Vercel function timeout

export async function GET(req: NextRequest) {
  // Auth: require CRON_SECRET to prevent abuse
  const secret = req.nextUrl.searchParams.get("secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rooms = await prisma.room.findMany({
    where: { isActive: true },
    include: {
      songs: {
        where: { isPlaying: true },
        take: 1,
      },
    },
  });

  const results: { code: string; status: string }[] = [];

  for (const room of rooms) {
    const currentSong = room.songs[0];
    if (!currentSong) {
      results.push({ code: room.code, status: "no_current_song" });
      continue;
    }

    const account = await prisma.account.findFirst({
      where: { userId: room.hostId, provider: "spotify" },
    });
    if (!account?.access_token) {
      results.push({ code: room.code, status: "no_token" });
      continue;
    }

    try {
      const accessToken = await getAccessToken(account);
      if (!accessToken) {
        results.push({ code: room.code, status: "token_refresh_failed" });
        continue;
      }

      const playback = await getCurrentPlayback(accessToken);

      if (!playback || !playback.item) {
        await prisma.roomSong.update({
          where: { id: currentSong.id },
          data: { isPlaying: false },
        });
        results.push({ code: room.code, status: "no_playback" });
        continue;
      }

      // Check if Spotify auto-advanced to the next CrowdDJ song
      if (playback.item.uri !== currentSong.spotifyUri) {
        const nextSong = await prisma.roomSong.findFirst({
          where: { roomId: room.id, isPlayed: false, isPlaying: false },
          orderBy: { sortOrder: "asc" },
        });

        if (nextSong && playback.item.uri === nextSong.spotifyUri && playback.is_playing) {
          const timeSinceLastAdvance = Date.now() - room.lastSyncAdvance.getTime();
          if (timeSinceLastAdvance < 10000) {
            results.push({ code: room.code, status: "debounced" });
            continue;
          }
          await prisma.room.update({ where: { id: room.id }, data: { lastSyncAdvance: new Date() } });
          await prisma.roomSong.update({ where: { id: currentSong.id }, data: { isPlaying: false, isPlayed: true } });
          await prisma.roomSong.update({ where: { id: nextSong.id }, data: { isPlaying: true } });
          await queueNext(room.id, nextSong.id, accessToken);
          results.push({ code: room.code, status: "advanced" });
          continue;
        }

        await prisma.roomSong.update({ where: { id: currentSong.id }, data: { isPlaying: false } });
        results.push({ code: room.code, status: "external_override" });
        continue;
      }

      // Check if song finished
      const isFinished =
        (!playback.is_playing && playback.progress_ms > playback.item.duration_ms - 3000) ||
        (!playback.is_playing && playback.progress_ms === 0 && playback.item.duration_ms > 0);

      if (isFinished) {
        const timeSinceLastAdvance = Date.now() - room.lastSyncAdvance.getTime();
        if (timeSinceLastAdvance < 10000) {
          results.push({ code: room.code, status: "debounced" });
          continue;
        }

        await prisma.room.update({ where: { id: room.id }, data: { lastSyncAdvance: new Date() } });
        await prisma.roomSong.update({ where: { id: currentSong.id }, data: { isPlaying: false, isPlayed: true } });

        const nextSong = await prisma.roomSong.findFirst({
          where: { roomId: room.id, isPlayed: false, isPlaying: false },
          orderBy: { sortOrder: "asc" },
        });

        if (nextSong) {
          await prisma.roomSong.update({ where: { id: nextSong.id }, data: { isPlaying: true } });
          try {
            await startPlayback(accessToken, [nextSong.spotifyUri]);
            await queueNext(room.id, nextSong.id, accessToken);
          } catch {}
          results.push({ code: room.code, status: "advanced_playback" });
        } else {
          results.push({ code: room.code, status: "queue_empty" });
        }
        continue;
      }

      // Pre-queue next song in last 45 seconds
      const remaining = playback.item.duration_ms - playback.progress_ms;
      if (playback.is_playing && remaining < 45000 && remaining > 5000) {
        await queueNext(room.id, currentSong.id, accessToken);
        results.push({ code: room.code, status: "pre_queued" });
      } else {
        results.push({ code: room.code, status: "playing" });
      }
    } catch (err) {
      results.push({ code: room.code, status: "error" });
    }
  }

  return NextResponse.json({ synced: rooms.length, results });
}

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

async function queueNext(roomId: string, currentSongId: string, accessToken: string) {
  try {
    const nextSong = await prisma.roomSong.findFirst({
      where: { roomId, isPlayed: false, isPlaying: false, id: { not: currentSongId } },
      orderBy: { sortOrder: "asc" },
    });
    if (nextSong) {
      await addToQueue(accessToken, nextSong.spotifyUri);
    }
  } catch {}
}
