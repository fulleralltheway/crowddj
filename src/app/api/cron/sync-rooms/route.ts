import { prisma } from "@/lib/db";
import { getNextSong } from "@/lib/queue";
import { getCurrentPlayback, addToQueue, skipToNext, startPlayback } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // When deferFade=true, the cron reports "needs_fade" instead of doing a hard skip,
  // letting the socket server handle the actual fade via /api/cron/fade-transition
  const deferFade = req.nextUrl.searchParams.get("deferFade") === "true";

  // Only sync specific rooms if provided (from socket server), otherwise all active
  const roomCodes = req.nextUrl.searchParams.get("rooms");
  const whereClause: any = { isActive: true };
  if (roomCodes) {
    const codes = roomCodes.split(",").filter(Boolean);
    if (codes.length > 0) whereClause.code = { in: codes };
  }

  const rooms = await prisma.room.findMany({
    where: whereClause,
    include: {
      songs: {
        where: { isPlaying: true },
        take: 1,
      },
    },
  });

  const results: { code: string; status: string; detail?: string }[] = [];

  // Report rooms that the caller asked about but aren't active (closed/expired/not found)
  if (roomCodes) {
    const codes = roomCodes.split(",").filter(Boolean);
    const foundCodes = new Set(rooms.map((r) => r.code));
    for (const code of codes) {
      if (!foundCodes.has(code)) {
        results.push({ code, status: "room_closed" });
      }
    }
  }

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

        // Auto-transition: works even when owner closes the app.
        // The cron handles pre-queueing and transitions server-side.
        // If the client is also open, it handles fading — the cron defers
        // to it by checking for a locked next song (client locks before fading).
        if (room.maxSongDurationSec >= 30 && playback.is_playing) {
          const maxMs = room.maxSongDurationSec * 1000;
          const timeSinceSync = Date.now() - room.lastSyncAdvance.getTime();

          // Pre-queue: 15s before threshold, lock the next song so UI shows "Queued Next"
          const preQueueMs = maxMs - 15000;
          if (playback.progress_ms >= preQueueMs && playback.progress_ms < maxMs && !room.lastPreQueuedId) {
            const nextUp = await getNextSong(room.id, room.autoShuffle);
            if (nextUp && !nextUp.isLocked) {
              await prisma.roomSong.update({
                where: { id: nextUp.id },
                data: { isLocked: true },
              });
              await prisma.room.update({
                where: { id: room.id },
                data: { lastPreQueuedId: nextUp.id },
              });
              results.push({ code: room.code, status: "prequeued_maxdur", detail: nextUp.trackName });
            }
          }

          // Transition: song is past threshold
          if (playback.progress_ms >= maxMs && timeSinceSync >= 15000) {
            // Check if a client is actively mid-fade (recently locked a song via lock-next).
            // lock-next sets lastSyncAdvance to now, so a recent lock means timeSinceSync < 30s.
            // If the lock is stale (30s+), the client abandoned it or the cron's own pre-queue
            // created it — safe to proceed with server-side transition.
            const hasLockedNext = await prisma.roomSong.findFirst({
              where: { roomId: room.id, isPlayed: false, isPlaying: false, isLocked: true },
            });
            const clientActivelyFading = hasLockedNext && timeSinceSync < 30000;
            if (!clientActivelyFading) {
              if (deferFade) {
                // Socket server will handle the fade — just report the need
                // Set lastSyncAdvance so this doesn't re-trigger on the next sync cycle
                await prisma.room.update({
                  where: { id: room.id },
                  data: { lastSyncAdvance: new Date() },
                });
                results.push({ code: room.code, status: "needs_fade" });
              } else {
                // No client or socket server handling it — cron does a hard skip
                await prisma.roomSong.update({
                  where: { id: currentSong.id },
                  data: { isPlaying: false, isPlayed: true },
                });
                const nextSong = await getNextSong(room.id, room.autoShuffle);
                if (nextSong) {
                  await prisma.roomSong.update({
                    where: { id: nextSong.id },
                    data: { isPlaying: true, isLocked: false },
                  });
                  try { await startPlayback(accessToken, [nextSong.spotifyUri]); } catch {
                    try { await startPlayback(accessToken, [nextSong.spotifyUri]); } catch {}
                  }
                  await prisma.room.update({
                    where: { id: room.id },
                    data: { lastPreQueuedId: null, lastSyncAdvance: new Date(), totalSongsPlayed: { increment: 1 } },
                  });
                  results.push({ code: room.code, status: "auto_transition", detail: nextSong.trackName });
                } else {
                  results.push({ code: room.code, status: "auto_transition_end" });
                }
              }
              continue;
            }
          }
        }

        // At 15 seconds remaining, queue the next song and lock it in
        // Skip pre-queue when maxSongDurationSec is active (auto-transition handles it)
        if (remaining <= 15000 && playback.is_playing && !room.lastPreQueuedId && !(room.maxSongDurationSec >= 30)) {
          const nextSong = await getNextSong(room.id, room.autoShuffle);

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
      const nextSong = await getNextSong(room.id, room.autoShuffle);

      // Check if Spotify advanced to our next queue song
      if (nextSong && playback.item.uri === nextSong.spotifyUri) {
        const timeSince = Date.now() - room.lastSyncAdvance.getTime();
        if (timeSince < 10000) {
          results.push({ code: room.code, status: "debounced" });
          continue;
        }

        await prisma.room.update({
          where: { id: room.id },
          data: { lastSyncAdvance: new Date(), lastPreQueuedId: null, totalSongsPlayed: { increment: 1 } },
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
            data: { lastSyncAdvance: new Date(), lastPreQueuedId: null, totalSongsPlayed: { increment: 1 } },
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

      // Spotify is playing something not in our queue.
      // Check if it matches ANY unplayed song in the room (played out of order).
      const matchInQueue = await prisma.roomSong.findFirst({
        where: { roomId: room.id, spotifyUri: playback.item.uri, isPlayed: false },
      });
      if (matchInQueue) {
        const timeSince = Date.now() - room.lastSyncAdvance.getTime();
        if (timeSince >= 10000) {
          // Mark old song as played, make the matched song current
          await prisma.roomSong.update({
            where: { id: currentSong.id },
            data: { isPlaying: false, isPlayed: true },
          });
          await prisma.roomSong.update({
            where: { id: matchInQueue.id },
            data: { isPlaying: true, isLocked: false },
          });
          await prisma.room.update({
            where: { id: room.id },
            data: { lastSyncAdvance: new Date(), lastPreQueuedId: null, totalSongsPlayed: { increment: 1 } },
          });
          results.push({ code: room.code, status: "advanced_external", detail: matchInQueue.trackName });
          continue;
        }
      }

      // External song not in queue — if maxSongDurationSec is active and Spotify
      // has been off-queue for a while, force-start the current queue song to
      // bring Spotify back in sync with the room.
      if (room.maxSongDurationSec >= 30 && playback.is_playing) {
        const timeSince = Date.now() - room.lastSyncAdvance.getTime();
        if (timeSince >= 30000) {
          try {
            await startPlayback(accessToken, [currentSong.spotifyUri]);
            await prisma.room.update({
              where: { id: room.id },
              data: { lastSyncAdvance: new Date() },
            });
            results.push({ code: room.code, status: "resynced", detail: currentSong.trackName });
          } catch {
            results.push({ code: room.code, status: "resync_failed" });
          }
          continue;
        }
      }

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
