import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getPlaylistTracks, reorderPlaylist } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 15;

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
        ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      },
    });
  }
  return accessToken;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.hostId !== session.user.id) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  // Accept a full ordered list of song IDs
  const { orderedIds } = body as { orderedIds: string[] };
  if (!orderedIds || !Array.isArray(orderedIds) || orderedIds.length === 0) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // Set dragInFlight = true AFTER auth + validation succeed so unauthorized
  // requests can't leak the flag. Clear it in finally on every exit path.
  await prisma.room.update({
    where: { id: room.id },
    data: { dragInFlight: true },
  });

  try {
    // Get the playing song's sortOrder as baseline
    const playingSong = await prisma.roomSong.findFirst({
      where: { roomId: room.id, isPlaying: true },
    });
    const startOrder = playingSong ? playingSong.sortOrder + 1 : 0;

    // Update all songs with new sort orders
    await Promise.all(
      orderedIds.map((id, i) =>
        prisma.roomSong.update({
          where: { id },
          data: { sortOrder: startOrder + i },
        })
      )
    );

    // In playlist mode, push the new order to Spotify and sync playlistPosition
    const sortMode = room.sortMode || (room.autoShuffle ? "votes" : "manual");
    if (sortMode === "playlist") {
      const orderedSongs = await prisma.roomSong.findMany({
        where: { roomId: room.id, isPlayed: false, isPlaying: false },
        orderBy: { sortOrder: "asc" },
        select: { id: true, spotifyUri: true },
      });
      // Update playlistPosition to match new drag order
      await Promise.all(
        orderedSongs.map((s, i) =>
          prisma.roomSong.update({ where: { id: s.id }, data: { playlistPosition: (playingSong ? i + 1 : i) } })
        )
      );
      // Push to Spotify with fresh token and full playlist preservation
      try {
        const account = await prisma.account.findFirst({
          where: { userId: session.user.id, provider: "spotify" },
        });
        if (account?.access_token) {
          const accessToken = await getAccessToken(account);
          if (accessToken) {
            // Fetch full playlist from Spotify so we don't lose songs outside the queue
            const playlistTracks = await getPlaylistTracks(accessToken, room.playlistId);
            const spotifyUris = playlistTracks.map((t: any) => t.spotifyUri);
            const queueUriSet = new Set(orderedSongs.map(s => s.spotifyUri));
            if (playingSong) queueUriSet.add(playingSong.spotifyUri);
            // Remove queue songs from Spotify list, then reinsert in new order
            const nonQueueUris = spotifyUris.filter((uri: string) => !queueUriSet.has(uri));
            const fullUris = [
              ...(playingSong ? [playingSong.spotifyUri] : []),
              ...orderedSongs.map(s => s.spotifyUri),
              ...nonQueueUris,
            ];
            const ok = await reorderPlaylist(accessToken, room.playlistId, fullUris);
            if (!ok) console.log("[Reorder] Failed to push to Spotify playlist");
          }
        }
      } catch (err) {
        console.log("[Reorder] Spotify push error:", err);
      }
    }

    return NextResponse.json({ success: true });
  } finally {
    // Clear dragInFlight on every exit path (success, error, throw).
    // Catch errors here in case room was deleted mid-drag (DELETE handler ran);
    // we don't want a stale-flag cleanup to mask the original error or 200.
    await prisma.room.update({
      where: { id: room.id },
      data: { dragInFlight: false },
    }).catch((err) => {
      console.log(`[Reorder] dragInFlight cleanup failed for room ${code}:`, err);
    });
  }
}
