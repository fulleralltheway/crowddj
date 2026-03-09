import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const accessToken = (session as any).accessToken;
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.hostId !== session.user.id) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const { trackId } = await req.json();
  if (!trackId) {
    return NextResponse.json({ error: "Missing trackId" }, { status: 400 });
  }

  // Fetch track details from Spotify to get preview_url
  const res = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    return NextResponse.json({ error: "Failed to fetch track" }, { status: 502 });
  }

  const track = await res.json();
  const previewUrl = track.preview_url || null;

  // Cache it in the DB if we got one
  if (previewUrl) {
    const song = await prisma.roomSong.findFirst({
      where: { roomId: room.id, spotifyUri: `spotify:track:${trackId}` },
    });
    if (song && !song.previewUrl) {
      await prisma.roomSong.update({
        where: { id: song.id },
        data: { previewUrl },
      });
    }
  }

  return NextResponse.json({ previewUrl });
}
