import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getPlaylistTracks, getAudioFeatures } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

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

  // Dual auth: session (manual sync from dashboard) OR CRON_SECRET (auto-sync from socket server)
  const secret = req.nextUrl.searchParams.get("secret");
  const isCronAuth = process.env.CRON_SECRET && secret === process.env.CRON_SECRET;

  let hostId: string | null = null;

  if (isCronAuth) {
    // Cron-authenticated — look up room to get hostId
    const room = await prisma.room.findUnique({ where: { code } });
    if (!room || !room.isActive) {
      return NextResponse.json({ error: "Room not found or inactive" }, { status: 404 });
    }
    hostId = room.hostId;
  } else {
    // Session-authenticated — verify host owns the room
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    hostId = session.user.id;
  }

  const room = await prisma.room.findUnique({
    where: { code },
    include: {
      songs: { select: { spotifyUri: true, isPlayed: true } },
    },
  });

  if (!room || !room.isActive) {
    return NextResponse.json({ error: "Room not found or inactive" }, { status: 404 });
  }

  if (!isCronAuth && room.hostId !== hostId) {
    return NextResponse.json({ error: "Not the room host" }, { status: 403 });
  }

  // Throttle: skip if synced within last 30 seconds
  if (room.lastPlaylistSync && Date.now() - room.lastPlaylistSync.getTime() < 30_000) {
    return NextResponse.json({ added: 0, throttled: true });
  }

  // Get host's Spotify token
  const account = await prisma.account.findFirst({
    where: { userId: room.hostId, provider: "spotify" },
  });
  if (!account?.access_token) {
    return NextResponse.json({ error: "No Spotify token" }, { status: 401 });
  }

  const accessToken = await getAccessToken(account);
  if (!accessToken) {
    return NextResponse.json({ error: "Token refresh failed" }, { status: 401 });
  }

  // Fetch current playlist tracks from Spotify
  let playlistTracks;
  try {
    playlistTracks = await getPlaylistTracks(accessToken, room.playlistId);
  } catch {
    return NextResponse.json({ error: "Failed to fetch playlist from Spotify" }, { status: 502 });
  }

  // Build sets for deduplication
  const unplayedUris = new Set<string>();
  const playedUris = new Set<string>();
  for (const song of room.songs) {
    if (song.isPlayed) {
      playedUris.add(song.spotifyUri);
    } else {
      unplayedUris.add(song.spotifyUri);
    }
  }

  // Update playlistPosition for existing unplayed songs based on current Spotify order
  const uriToPosition = new Map<string, number>();
  playlistTracks.forEach((t: any, i: number) => uriToPosition.set(t.spotifyUri, i));
  const existingSongsForPos = await prisma.roomSong.findMany({
    where: { roomId: room.id, isPlayed: false },
    select: { id: true, spotifyUri: true, playlistPosition: true },
  });
  const positionUpdates = existingSongsForPos
    .filter(s => uriToPosition.has(s.spotifyUri) && uriToPosition.get(s.spotifyUri) !== s.playlistPosition)
    .map(s => prisma.roomSong.update({
      where: { id: s.id },
      data: { playlistPosition: uriToPosition.get(s.spotifyUri)! },
    }));
  if (positionUpdates.length > 0) await Promise.all(positionUpdates);

  // Filter to only new songs
  const newTracks = playlistTracks.filter((track: any) => {
    // Skip if an unplayed copy already exists in the queue
    if (unplayedUris.has(track.spotifyUri)) return false;
    // If song was played, only allow re-add when allowDuplicates is on
    if (playedUris.has(track.spotifyUri)) return room.allowDuplicates;
    // Truly new song
    return true;
  });

  if (newTracks.length === 0) {
    // Update sync timestamp even if nothing new (so we don't re-check immediately)
    await prisma.room.update({
      where: { id: room.id },
      data: { lastPlaylistSync: new Date() },
    });
    return NextResponse.json({ added: 0 });
  }

  // Get current max sortOrder
  const maxOrder = await prisma.roomSong.findFirst({
    where: { roomId: room.id },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  let nextOrder = (maxOrder?.sortOrder ?? -1) + 1;

  // Check for pending requests that match new songs
  const newUris = newTracks.map((t: any) => t.spotifyUri);
  const pendingRequests = await prisma.songRequest.findMany({
    where: {
      roomId: room.id,
      spotifyUri: { in: newUris },
      status: "pending",
    },
  });
  const pendingByUri = new Map<string, any>();
  for (const req of pendingRequests) {
    // Use first pending request per URI
    if (!pendingByUri.has(req.spotifyUri)) {
      pendingByUri.set(req.spotifyUri, req);
    }
  }

  // Create new RoomSong rows
  const songsToCreate = newTracks.map((track: any) => {
    const pendingReq = pendingByUri.get(track.spotifyUri);
    return {
      roomId: room.id,
      spotifyUri: track.spotifyUri,
      trackName: track.trackName,
      artistName: track.artistName,
      albumArt: track.albumArt,
      durationMs: track.durationMs,
      previewUrl: track.previewUrl,
      sortOrder: nextOrder++,
      playlistPosition: uriToPosition.get(track.spotifyUri) ?? nextOrder - 1,
      isRequested: !!pendingReq,
      addedBy: pendingReq?.requestedBy ?? null,
      addedByName: pendingReq?.requestedByName ?? null,
    };
  });

  await prisma.roomSong.createMany({ data: songsToCreate });

  // Auto-approve matching pending requests
  if (pendingRequests.length > 0) {
    await prisma.songRequest.updateMany({
      where: {
        id: { in: pendingRequests.map((r) => r.id) },
      },
      data: { status: "approved" },
    });
  }

  // Update sync timestamp
  await prisma.room.update({
    where: { id: room.id },
    data: { lastPlaylistSync: new Date() },
  });

  // Fetch audio features for new songs (non-critical)
  try {
    const trackIds = newTracks
      .map((t: any) => {
        const match = t.spotifyUri.match(/spotify:track:(.+)/);
        return match ? match[1] : null;
      })
      .filter((id: string | null): id is string => id !== null);

    if (trackIds.length > 0) {
      const features = await getAudioFeatures(accessToken, trackIds);
      const featureMap = new Map<string, { tempo: number; energy: number; danceability: number }>();
      for (const f of features) {
        if (f) featureMap.set(f.id, { tempo: f.tempo, energy: f.energy, danceability: f.danceability });
      }

      // Find the newly created songs to update
      const createdSongs = await prisma.roomSong.findMany({
        where: {
          roomId: room.id,
          spotifyUri: { in: newUris },
          sortOrder: { gte: (maxOrder?.sortOrder ?? -1) + 1 },
        },
      });

      const updates = createdSongs
        .map((song) => {
          const match = song.spotifyUri.match(/spotify:track:(.+)/);
          const id = match ? match[1] : null;
          const feat = id ? featureMap.get(id) : null;
          if (!feat) return null;
          return prisma.roomSong.update({
            where: { id: song.id },
            data: { tempo: feat.tempo, energy: feat.energy, danceability: feat.danceability },
          });
        })
        .filter(Boolean);

      await Promise.all(updates);
    }
  } catch {
    // Audio features are non-critical
  }

  return NextResponse.json({
    added: newTracks.length,
    songs: newTracks.map((t: any) => ({
      trackName: t.trackName,
      artistName: t.artistName,
      spotifyUri: t.spotifyUri,
    })),
  });
}
