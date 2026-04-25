import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const room = await prisma.room.findUnique({ where: { id } });
  if (!room) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }
  if (room.hostId !== session.user.id) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  if (room.isActive) {
    return NextResponse.json(
      { error: "Room is still active — events are only available for closed rooms" },
      { status: 410 }
    );
  }

  // All songs played in this room, chronological
  const playedRows = await prisma.roomSong.findMany({
    where: { roomId: room.id, isPlayed: true },
    orderBy: [{ playedAt: "asc" }, { sortOrder: "asc" }],
  });

  // Compute net score in JS (Prisma can't easily order by computed expression)
  const allSongs = await prisma.roomSong.findMany({
    where: { roomId: room.id },
    select: {
      id: true,
      trackName: true,
      artistName: true,
      albumArt: true,
      upvotes: true,
      downvotes: true,
    },
  });
  const topVoted = allSongs
    .map((s) => ({ ...s, netScore: s.upvotes - s.downvotes }))
    .sort((a, b) => {
      if (b.netScore !== a.netScore) return b.netScore - a.netScore;
      if (b.upvotes !== a.upvotes) return b.upvotes - a.upvotes;
      return a.id.localeCompare(b.id);
    })
    .slice(0, 10)
    .map((s, i) => ({
      id: s.id,
      trackName: s.trackName,
      artistName: s.artistName,
      albumArt: s.albumArt,
      upvotes: s.upvotes,
      downvotes: s.downvotes,
      netScore: s.netScore,
      rank: i + 1,
    }));

  // Request status counts
  const requestRows = await prisma.songRequest.findMany({
    where: { roomId: room.id },
    select: { status: true },
  });
  let requestApprovedCount = 0;
  let requestRejectedCount = 0;
  let requestPendingCount = 0;
  for (const r of requestRows) {
    if (r.status === "approved") requestApprovedCount++;
    else if (r.status === "rejected") requestRejectedCount++;
    else if (r.status === "pending") requestPendingCount++;
  }

  // Duration
  const endTime = room.closedAt ?? room.updatedAt;
  const durationMinutes = Math.max(
    0,
    Math.round((endTime.getTime() - room.createdAt.getTime()) / 60000)
  );

  // Aggregate vote stats from songsPlayed for averages
  const totalSongsPlayed = playedRows.length;
  const totalVotesOnPlayed = playedRows.reduce(
    (sum, s) => sum + s.upvotes + s.downvotes,
    0
  );
  const averageVotesPerSong =
    totalSongsPlayed > 0
      ? Math.round((totalVotesOnPlayed / totalSongsPlayed) * 10) / 10
      : 0;

  const songsPlayed = playedRows.map((s, i) => ({
    id: s.id,
    spotifyUri: s.spotifyUri,
    trackName: s.trackName,
    artistName: s.artistName,
    albumArt: s.albumArt,
    durationMs: s.durationMs,
    playedAt: (s.playedAt ?? s.createdAt).toISOString(),
    upvotes: s.upvotes,
    downvotes: s.downvotes,
    netScore: s.upvotes - s.downvotes,
    order: i + 1,
  }));

  return NextResponse.json({
    room: {
      id: room.id,
      name: room.name,
      playlistName: room.playlistName,
      playlistId: room.playlistId,
      createdAt: room.createdAt.toISOString(),
      closedAt: room.closedAt ? room.closedAt.toISOString() : null,
    },
    stats: {
      durationMinutes,
      totalSongsPlayed,
      totalVotesCast: room.totalVotesCast,
      peakGuestCount: room.peakGuestCount,
      averageVotesPerSong,
      requestCount: requestRows.length,
      requestApprovedCount,
      requestRejectedCount,
      requestPendingCount,
    },
    songsPlayed,
    topVotedSongs: topVoted,
  });
}
