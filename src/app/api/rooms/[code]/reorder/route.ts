import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { reorderPlaylist } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 15;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.hostId !== session.user.id) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  // Accept a full ordered list of song IDs
  const { orderedIds } = body as { orderedIds: string[] };
  if (!orderedIds || !Array.isArray(orderedIds) || orderedIds.length === 0) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // Get the playing song's sortOrder as baseline
  const playingSong = await prisma.roomSong.findFirst({
    where: { roomId: room.id, isPlaying: true },
  });
  const startOrder = playingSong ? playingSong.sortOrder + 1 : 0;

  // Update all songs with new sort orders
  await Promise.all(
    orderedIds.map((id, i) =>
      prisma.roomSong.update({
        where: { id },
        data: { sortOrder: startOrder + i },
      })
    )
  );

  // In playlist mode, push the new order to Spotify and sync playlistPosition
  const sortMode = room.sortMode || (room.autoShuffle ? "votes" : "manual");
  if (sortMode === "playlist") {
    const orderedSongs = await prisma.roomSong.findMany({
      where: { roomId: room.id, isPlayed: false, isPlaying: false },
      orderBy: { sortOrder: "asc" },
      select: { id: true, spotifyUri: true },
    });
    // Update playlistPosition to match new drag order
    await Promise.all(
      orderedSongs.map((s, i) =>
        prisma.roomSong.update({ where: { id: s.id }, data: { playlistPosition: (playingSong ? i + 1 : i) } })
      )
    );
    // Push to Spotify (fire-and-forget)
    const account = await prisma.account.findFirst({
      where: { userId: session.user.id, provider: "spotify" },
    });
    if (account?.access_token) {
      const uris = [
        ...(playingSong ? [playingSong.spotifyUri] : []),
        ...orderedSongs.map(s => s.spotifyUri),
      ];
      reorderPlaylist(account.access_token, room.playlistId, uris).catch(() => {});
    }
  }

  return NextResponse.json({ success: true });
}
