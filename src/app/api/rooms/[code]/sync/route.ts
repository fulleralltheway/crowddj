import { prisma } from "@/lib/db";
import { getCurrentPlayback } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

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

// Read-only sync endpoint: reports current Spotify playback state
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || !room.isActive) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }

  const account = await prisma.account.findFirst({
    where: { userId: room.hostId, provider: "spotify" },
  });
  if (!account?.access_token) {
    return NextResponse.json({ synced: false });
  }

  const accessToken = await getAccessToken(account).catch(() => null);
  if (!accessToken) {
    return NextResponse.json({ synced: false });
  }

  try {
    const playback = await getCurrentPlayback(accessToken);

    if (!playback || !playback.item) {
      return NextResponse.json({ synced: true, playing: false, reason: "no_playback" });
    }

    const track = playback.item;
    return NextResponse.json({
      synced: true,
      playing: true,
      spotifyPlaying: !!playback.is_playing,
      progressMs: playback.progress_ms,
      durationMs: track.duration_ms,
      lastPreQueuedId: room.lastPreQueuedId,
      // Always return what Spotify is actually playing
      spotifyTrack: {
        uri: track.uri,
        name: track.name,
        artist: track.artists?.map((a: any) => a.name).join(", ") || "Unknown",
        albumArt: track.album?.images?.[0]?.url || null,
      },
    });
  } catch {
    return NextResponse.json({ synced: false });
  }
}
