import { prisma } from "@/lib/db";
import { searchTracks } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const q = req.nextUrl.searchParams.get("q");
  if (!q) return NextResponse.json({ error: "Missing query" }, { status: 400 });

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || !room.isActive) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }

  // Use the host's Spotify token
  const account = await prisma.account.findFirst({
    where: { userId: room.hostId, provider: "spotify" },
  });

  if (!account?.access_token) {
    return NextResponse.json({ error: "Host token unavailable" }, { status: 503 });
  }

  // Check if token is expired and refresh if needed
  let accessToken = account.access_token;
  if (account.expires_at && account.expires_at * 1000 < Date.now()) {
    try {
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
      if (res.ok) {
        accessToken = tokens.access_token;
        await prisma.account.update({
          where: { id: account.id },
          data: {
            access_token: tokens.access_token,
            expires_at: Math.floor(Date.now() / 1000 + tokens.expires_in),
            refresh_token: tokens.refresh_token ?? account.refresh_token,
          },
        });
      } else {
        return NextResponse.json({ error: "Token refresh failed" }, { status: 503 });
      }
    } catch {
      return NextResponse.json({ error: "Token refresh failed" }, { status: 503 });
    }
  }

  try {
    const tracks = await searchTracks(accessToken, q);

    // Check against displayed songs: base playlist (limited) + all requested
    const limit = room.queueDisplaySize || 50;
    const [baseUris, requestedUris] = await Promise.all([
      prisma.roomSong.findMany({
        where: { roomId: room.id, isPlayed: false, isRequested: false },
        orderBy: [{ isPlaying: "desc" }, { sortOrder: "asc" }],
        take: limit,
        select: { spotifyUri: true },
      }),
      prisma.roomSong.findMany({
        where: { roomId: room.id, isPlayed: false, isRequested: true },
        select: { spotifyUri: true },
      }),
    ]);
    const uriSet = new Set([...baseUris, ...requestedUris].map((s) => s.spotifyUri));

    // Check for already-played songs (if replays are disabled)
    let playedSet = new Set<string>();
    if (!room.allowDuplicates) {
      const playedSongs = await prisma.roomSong.findMany({
        where: { roomId: room.id, isPlayed: true },
        select: { spotifyUri: true },
      });
      playedSet = new Set(playedSongs.map((s) => s.spotifyUri));
    }

    // Filter out explicit songs if explicitFilter is enabled
    let filtered = room.explicitFilter
      ? tracks.filter((t: any) => !t.isExplicit)
      : tracks;

    // Filter blocked artists
    if (room.blockedArtists) {
      const blocked = room.blockedArtists.split(",").map(a => a.trim().toLowerCase()).filter(Boolean);
      filtered = filtered.filter((t: any) => {
        const artist = (t.artistName || "").toLowerCase();
        return !blocked.some(b => artist.includes(b) || b.includes(artist));
      });
    }

    const enriched = filtered.map((t: any) => ({
      ...t,
      inQueue: uriSet.has(t.spotifyUri),
      alreadyPlayed: playedSet.has(t.spotifyUri),
    }));

    return NextResponse.json(enriched);
  } catch {
    return NextResponse.json({ error: "Failed to search" }, { status: 500 });
  }
}
