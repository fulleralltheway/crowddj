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
    return NextResponse.json(tracks);
  } catch {
    return NextResponse.json({ error: "Failed to search" }, { status: 500 });
  }
}
