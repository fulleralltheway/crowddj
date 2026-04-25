import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getPlaylistTracks, getAudioFeatures } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

function generateRoomCode(): string {
  // Mirror create-room generator (avoids ambiguous 0/O, 1/I)
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accessToken = (session as any).accessToken;
  if (!accessToken) {
    return NextResponse.json({ error: "No Spotify token" }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const { sourceRoomId } = body || {};
  if (!sourceRoomId || typeof sourceRoomId !== "string") {
    return NextResponse.json({ error: "Missing sourceRoomId" }, { status: 400 });
  }

  const source = await prisma.room.findUnique({ where: { id: sourceRoomId } });
  if (!source) {
    return NextResponse.json({ error: "Source room not found" }, { status: 404 });
  }
  if (source.hostId !== session.user.id) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  // Validate playlist still accessible
  const checkRes = await fetch(
    `https://api.spotify.com/v1/playlists/${source.playlistId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (checkRes.status === 404 || checkRes.status === 403) {
    return NextResponse.json(
      { error: "Playlist no longer accessible" },
      { status: 400 }
    );
  }
  if (!checkRes.ok) {
    return NextResponse.json(
      { error: "Failed to verify playlist with Spotify" },
      { status: 502 }
    );
  }

  // Auto-close any existing active rooms for this host (only one at a time)
  // — mirrors POST /api/rooms behavior
  await prisma.room.updateMany({
    where: { hostId: session.user.id, isActive: true },
    data: { isActive: false, closedAt: new Date() },
  });

  // Generate fresh unique room code with retry on collision
  let code = generateRoomCode();
  let attempts = 0;
  while (await prisma.room.findUnique({ where: { code } })) {
    code = generateRoomCode();
    attempts++;
    if (attempts > 20) {
      return NextResponse.json(
        { error: "Failed to generate unique room code" },
        { status: 500 }
      );
    }
  }

  // Fetch playlist tracks
  let tracks;
  try {
    tracks = await getPlaylistTracks(accessToken, source.playlistId);
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch playlist from Spotify" },
      { status: 502 }
    );
  }

  // Create new room — carry settings, reset state
  const room = await prisma.room.create({
    data: {
      code,
      name: source.name,
      hostId: session.user.id,
      playlistId: source.playlistId,
      playlistName: source.playlistName,
      // Carried settings
      votesPerUser: source.votesPerUser,
      voteResetMinutes: source.voteResetMinutes,
      requireApproval: source.requireApproval,
      votingPaused: false,
      maxSongsPerGuest: source.maxSongsPerGuest,
      explicitFilter: source.explicitFilter,
      autoShuffle: source.autoShuffle,
      sortMode: source.sortMode,
      queueDisplaySize: source.queueDisplaySize,
      allowDuplicates: source.allowDuplicates,
      maxSongDurationSec: source.maxSongDurationSec,
      fadeDurationSec: source.fadeDurationSec,
      blockedArtists: source.blockedArtists,
      blockedSongs: source.blockedSongs,
      brandColor: source.brandColor,
      brandName: source.brandName,
      // Reset state
      isActive: true,
      closedAt: null,
      dragInFlight: false,
      totalSongsPlayed: 0,
      totalVotesCast: 0,
      peakGuestCount: 0,
      lastPreQueuedId: null,
      scheduledStart: null,
      lastPlaylistSync: null,
      // Songs from playlist re-import
      songs: {
        create: tracks.map((track: any, index: number) => ({
          spotifyUri: track.spotifyUri,
          trackName: track.trackName,
          artistName: track.artistName,
          albumArt: track.albumArt,
          durationMs: track.durationMs,
          previewUrl: track.previewUrl,
          sortOrder: index,
          playlistPosition: index,
        })),
      },
    },
    include: { songs: true },
  });

  // Audio features (non-critical, mirrors create-room)
  try {
    const trackIds = room.songs
      .map((s) => {
        const match = s.spotifyUri.match(/spotify:track:(.+)/);
        return match ? match[1] : null;
      })
      .filter((id): id is string => id !== null);

    if (trackIds.length > 0) {
      const features = await getAudioFeatures(accessToken, trackIds);
      const featureMap = new Map<
        string,
        { tempo: number; energy: number; danceability: number }
      >();
      for (const f of features) {
        if (f) {
          featureMap.set(f.id, {
            tempo: f.tempo,
            energy: f.energy,
            danceability: f.danceability,
          });
        }
      }

      const updates = room.songs
        .map((song) => {
          const match = song.spotifyUri.match(/spotify:track:(.+)/);
          const id = match ? match[1] : null;
          const feat = id ? featureMap.get(id) : null;
          if (!feat) return null;
          return prisma.roomSong.update({
            where: { id: song.id },
            data: {
              tempo: feat.tempo,
              energy: feat.energy,
              danceability: feat.danceability,
            },
          });
        })
        .filter(Boolean);

      await Promise.all(updates);

      const updatedSongs = await prisma.roomSong.findMany({
        where: { roomId: room.id },
        orderBy: { sortOrder: "asc" },
      });
      return NextResponse.json({ ...room, songs: updatedSongs });
    }
  } catch {
    // Audio features are non-critical
  }

  return NextResponse.json(room);
}
