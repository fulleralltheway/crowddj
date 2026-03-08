import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

const SPOTIFY_API = "https://api.spotify.com/v1";

// GET pending requests (host only)
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.hostId !== session.user.id) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const requests = await prisma.songRequest.findMany({
    where: { roomId: room.id, status: "pending" },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json(requests);
}

// PATCH - approve or reject a request (host only)
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { requestId, action } = await req.json();
  if (!requestId || (action !== "approve" && action !== "reject")) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.hostId !== session.user.id) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const songRequest = await prisma.songRequest.update({
    where: { id: requestId },
    data: { status: action === "approve" ? "approved" : "rejected" },
  });

  if (action === "approve") {
    // Check if the song already exists in the queue (e.g. beyond display limit)
    const existing = await prisma.roomSong.findFirst({
      where: { roomId: room.id, spotifyUri: songRequest.spotifyUri, isPlayed: false },
    });

    const maxOrder = await prisma.roomSong.findFirst({
      where: { roomId: room.id },
      orderBy: { sortOrder: "desc" },
    });
    const newOrder = (maxOrder?.sortOrder ?? -1) + 1;

    // Fetch previewUrl from Spotify for the approved song
    let previewUrl: string | null = null;
    try {
      const trackMatch = songRequest.spotifyUri.match(/spotify:track:(.+)/);
      if (trackMatch) {
        const account = await prisma.account.findFirst({
          where: { userId: room.hostId, provider: "spotify" },
        });
        if (account?.access_token) {
          const trackRes = await fetch(`${SPOTIFY_API}/tracks/${trackMatch[1]}`, {
            headers: { Authorization: `Bearer ${account.access_token}` },
          });
          if (trackRes.ok) {
            const trackData = await trackRes.json();
            previewUrl = trackData.preview_url || null;
          }
        }
      }
    } catch {
      // Non-critical — continue without preview URL
    }

    if (existing) {
      // Bump existing song into visible queue
      await prisma.roomSong.update({
        where: { id: existing.id },
        data: {
          isRequested: true,
          sortOrder: newOrder,
          ...(previewUrl && !existing.previewUrl ? { previewUrl } : {}),
        },
      });
    } else {
      await prisma.roomSong.create({
        data: {
          roomId: room.id,
          spotifyUri: songRequest.spotifyUri,
          trackName: songRequest.trackName,
          artistName: songRequest.artistName,
          albumArt: songRequest.albumArt,
          durationMs: songRequest.durationMs,
          previewUrl,
          sortOrder: newOrder,
          isRequested: true,
          addedBy: songRequest.requestedBy,
          addedByName: songRequest.requestedByName,
        },
      });
    }
  }

  return NextResponse.json({ success: true });
}
