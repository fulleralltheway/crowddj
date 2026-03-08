import { prisma } from "@/lib/db";
import { getCurrentPlayback, addToQueue } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
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

  const results: { code: string; status: string; detail?: string }[] = [];

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
        results.push({ code: room.code, status: "no_playback" });
        continue;
      }

      // CASE 1: Spotify is playing our current song
      if (playback.item.uri === currentSong.spotifyUri) {
        const remaining = playback.item.duration_ms - playback.progress_ms;

        // At 15 seconds remaining, queue the next song and lock it in
        if (remaining <= 15000 && playback.is_playing && !room.lastPreQueuedId) {
          const nextSong = await prisma.roomSong.findFirst({
            where: { roomId: room.id, isPlayed: false, isPlaying: false },
            orderBy: { sortOrder: "asc" },
          });

          if (nextSong) {
            try {
              await addToQueue(accessToken, nextSong.spotifyUri);
              // Lock the song and record that we queued it
              await prisma.roomSong.update({
                where: { id: nextSong.id },
                data: { isLocked: true },
              });
              await prisma.room.update({
                where: { id: room.id },
                data: { lastPreQueuedId: nextSong.id },
              });
              results.push({ code: room.code, status: "queued_next", detail: nextSong.trackName });
            } catch {
              results.push({ code: room.code, status: "queue_failed" });
            }
            continue;
          }
        }

        results.push({ code: room.code, status: "playing" });
        continue;
      }

      // CASE 2: Spotify moved to a different song
      const nextSong = await prisma.roomSong.findFirst({
        where: { roomId: room.id, isPlayed: false, isPlaying: false },
        orderBy: { sortOrder: "asc" },
      });

      // Check if Spotify advanced to our next queue song
      if (nextSong && playback.item.uri === nextSong.spotifyUri) {
        const timeSince = Date.now() - room.lastSyncAdvance.getTime();
        if (timeSince < 10000) {
          results.push({ code: room.code, status: "debounced" });
          continue;
        }

        await prisma.room.update({
          where: { id: room.id },
          data: { lastSyncAdvance: new Date(), lastPreQueuedId: null },
        });
        await prisma.roomSong.update({
          where: { id: currentSong.id },
          data: { isPlaying: false, isPlayed: true },
        });
        await prisma.roomSong.update({
          where: { id: nextSong.id },
          data: { isPlaying: true, isLocked: false },
        });

        results.push({ code: room.code, status: "advanced", detail: nextSong.trackName });
        continue;
      }

      // Check if Spotify advanced to the song we pre-queued
      if (room.lastPreQueuedId) {
        const preQueued = await prisma.roomSong.findUnique({
          where: { id: room.lastPreQueuedId },
        });
        if (preQueued && playback.item.uri === preQueued.spotifyUri) {
          const timeSince = Date.now() - room.lastSyncAdvance.getTime();
          if (timeSince < 10000) {
            results.push({ code: room.code, status: "debounced" });
            continue;
          }

          await prisma.room.update({
            where: { id: room.id },
            data: { lastSyncAdvance: new Date(), lastPreQueuedId: null },
          });
          await prisma.roomSong.update({
            where: { id: currentSong.id },
            data: { isPlaying: false, isPlayed: true },
          });
          await prisma.roomSong.update({
            where: { id: preQueued.id },
            data: { isPlaying: true, isLocked: false },
          });

          results.push({ code: room.code, status: "advanced_prequeued", detail: preQueued.trackName });
          continue;
        }
      }

      // Spotify is playing something not in our queue
      results.push({ code: room.code, status: "external", detail: playback.item.name });
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
