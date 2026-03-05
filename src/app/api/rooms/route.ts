import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getPlaylistTracks } from "@/lib/spotify";
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
  const { playlistId, playlistName, name, votesPerUser, voteResetMinutes, requireApproval } = body;

  if (!playlistId || !playlistName || !name) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Generate unique room code
  let code = generateRoomCode();
  while (await prisma.room.findUnique({ where: { code } })) {
    code = generateRoomCode();
  }

  // Fetch playlist tracks from Spotify
  const tracks = await getPlaylistTracks(accessToken, playlistId);

  // Create room with songs
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
      songs: {
        create: tracks.map((track: any, index: number) => ({
          spotifyUri: track.spotifyUri,
          trackName: track.trackName,
          artistName: track.artistName,
          albumArt: track.albumArt,
          durationMs: track.durationMs,
          sortOrder: index,
        })),
      },
    },
    include: { songs: true },
  });

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
