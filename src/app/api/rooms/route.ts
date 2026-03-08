import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getPlaylistTracks, getAudioFeatures } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

function generateRoomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const accessToken = (session as any).accessToken;
  if (!accessToken) return NextResponse.json({ error: "No Spotify token" }, { status: 401 });

  const body = await req.json();
  const { playlistId, playlistName, name, votesPerUser, voteResetMinutes, requireApproval, scheduledStart } = body;

  if (!playlistId || !playlistName || !name) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Auto-close any existing active rooms for this host (only one at a time)
  await prisma.room.updateMany({
    where: { hostId: session.user.id, isActive: true },
    data: { isActive: false },
  });

  // Generate unique room code
  let code = generateRoomCode();
  while (await prisma.room.findUnique({ where: { code } })) {
    code = generateRoomCode();
  }

  // Fetch playlist tracks from Spotify
  const tracks = await getPlaylistTracks(accessToken, playlistId);

  // Create room with songs (include previewUrl)
  const room = await prisma.room.create({
    data: {
      code,
      name,
      hostId: session.user.id,
      playlistId,
      playlistName,
      votesPerUser: votesPerUser || 5,
      voteResetMinutes: voteResetMinutes || 30,
      requireApproval: requireApproval || false,
      ...(scheduledStart ? { scheduledStart: new Date(scheduledStart) } : {}),
      songs: {
        create: tracks.map((track: any, index: number) => ({
          spotifyUri: track.spotifyUri,
          trackName: track.trackName,
          artistName: track.artistName,
          albumArt: track.albumArt,
          durationMs: track.durationMs,
          previewUrl: track.previewUrl,
          sortOrder: index,
        })),
      },
    },
    include: { songs: true },
  });

  // Batch-fetch audio features and update songs
  try {
    const trackIds = room.songs
      .map((s) => {
        const match = s.spotifyUri.match(/spotify:track:(.+)/);
        return match ? match[1] : null;
      })
      .filter((id): id is string => id !== null);

    if (trackIds.length > 0) {
      const features = await getAudioFeatures(accessToken, trackIds);
      const featureMap = new Map<string, { tempo: number; energy: number; danceability: number }>();
      for (const f of features) {
        if (f) featureMap.set(f.id, { tempo: f.tempo, energy: f.energy, danceability: f.danceability });
      }

      // Update songs with audio features in parallel
      const updates = room.songs
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

      // Re-fetch songs with updated features
      const updatedSongs = await prisma.roomSong.findMany({
        where: { roomId: room.id },
        orderBy: { sortOrder: "asc" },
      });
      return NextResponse.json({ ...room, songs: updatedSongs });
    }
  } catch {
    // Audio features are non-critical — return room without them
  }

  return NextResponse.json(room);
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rooms = await prisma.room.findMany({
    where: { hostId: session.user.id },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(rooms);
}
