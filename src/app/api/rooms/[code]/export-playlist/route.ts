import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { createPlaylist, addTracksToPlaylist } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

export async function POST(
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

  const playedSongs = await prisma.roomSong.findMany({
    where: { roomId: room.id, isPlayed: true },
    orderBy: [{ playedAt: "asc" }, { sortOrder: "asc" }],
  });

  if (playedSongs.length === 0) {
    return NextResponse.json({ error: "No songs were played" }, { status: 400 });
  }

  const account = await prisma.account.findFirst({
    where: { userId: session.user.id, provider: "spotify" },
  });
  if (!account?.access_token) {
    return NextResponse.json({ error: "No Spotify token" }, { status: 401 });
  }

  let accessToken = account.access_token;

  // Refresh if expired
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
    if (!res.ok) return NextResponse.json({ error: "Token refresh failed" }, { status: 401 });

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

  // Get Spotify user ID
  const profileRes = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!profileRes.ok) {
    return NextResponse.json({ error: "Failed to get Spotify profile" }, { status: 500 });
  }
  const profile = await profileRes.json();

  // Format date for playlist name
  const date = new Date();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dateStr = `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
  const playlistName = `${room.name} - ${dateStr}`;

  const playlist = await createPlaylist(
    accessToken,
    profile.id,
    playlistName,
    `${playedSongs.length} songs played during PartyQueue session`
  );

  const uris = playedSongs.map((s) => s.spotifyUri);
  await addTracksToPlaylist(accessToken, playlist.id, uris);

  return NextResponse.json({
    success: true,
    playlistUrl: playlist.external_urls.spotify,
    playlistName,
    trackCount: playedSongs.length,
  });
}
