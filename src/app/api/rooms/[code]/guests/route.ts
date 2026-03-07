import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });

  const detail = req.nextUrl.searchParams.get("detail");

  if (detail === "true") {
    // Host-only: return full guest list with stats
    const session = await auth();
    if (!session?.user?.id || room.hostId !== session.user.id) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }

    const guests = await prisma.guest.findMany({
      where: { roomId: room.id, name: { not: "" } },
      orderBy: { createdAt: "asc" },
      include: {
        votes: {
          select: { value: true, song: { select: { trackName: true, artistName: true } } },
        },
      },
    });

    // Count song requests per guest fingerprint
    const requests = await prisma.songRequest.findMany({
      where: { roomId: room.id },
      select: { requestedBy: true, status: true },
    });
    const requestsByFp = new Map<string, { total: number; approved: number }>();
    for (const r of requests) {
      const entry = requestsByFp.get(r.requestedBy) || { total: 0, approved: 0 };
      entry.total++;
      if (r.status === "approved") entry.approved++;
      requestsByFp.set(r.requestedBy, entry);
    }

    // Count songs added directly (approved or no-approval-needed)
    const addedSongs = await prisma.roomSong.findMany({
      where: { roomId: room.id, addedBy: { not: null } },
      select: { addedBy: true },
    });
    const addedByFp = new Map<string, number>();
    for (const s of addedSongs) {
      if (s.addedBy) addedByFp.set(s.addedBy, (addedByFp.get(s.addedBy) || 0) + 1);
    }

    const detailed = guests.map((g) => {
      const upvotes = g.votes.filter((v) => v.value === 1);
      const downvotes = g.votes.filter((v) => v.value === -1);
      const reqs = requestsByFp.get(g.fingerprint) || { total: 0, approved: 0 };
      return {
        id: g.id,
        name: g.name,
        joinedAt: g.createdAt,
        totalVotes: g.votes.length,
        upvotes: upvotes.length,
        downvotes: downvotes.length,
        songsRequested: reqs.total,
        songsAdded: addedByFp.get(g.fingerprint) || 0,
        votedSongs: g.votes.slice(0, 20).map((v) => ({
          trackName: v.song.trackName,
          artistName: v.song.artistName,
          value: v.value,
        })),
      };
    });

    return NextResponse.json({ count: guests.length, guests: detailed });
  }

  const count = await prisma.guest.count({
    where: { roomId: room.id },
  });

  return NextResponse.json({ count });
}
