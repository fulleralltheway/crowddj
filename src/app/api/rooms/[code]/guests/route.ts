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
          select: {
            value: true,
            song: { select: { trackName: true, artistName: true, albumArt: true, isPlayed: true } },
          },
        },
      },
    });

    // Song requests per guest fingerprint (with full details)
    const allRequests = await prisma.songRequest.findMany({
      where: { roomId: room.id },
      select: { requestedBy: true, status: true, trackName: true, artistName: true, albumArt: true },
    });
    const requestsByFp = new Map<string, typeof allRequests>();
    for (const r of allRequests) {
      const arr = requestsByFp.get(r.requestedBy) || [];
      arr.push(r);
      requestsByFp.set(r.requestedBy, arr);
    }

    // Songs added directly per guest fingerprint
    const addedSongs = await prisma.roomSong.findMany({
      where: { roomId: room.id, addedBy: { not: null } },
      select: { addedBy: true, trackName: true, artistName: true, albumArt: true },
    });
    const addedByFp = new Map<string, typeof addedSongs>();
    for (const s of addedSongs) {
      if (s.addedBy) {
        const arr = addedByFp.get(s.addedBy) || [];
        arr.push(s);
        addedByFp.set(s.addedBy, arr);
      }
    }

    const detailed = guests.map((g) => {
      const currentUpvotes = g.votes.filter((v) => v.value === 1);
      const currentDownvotes = g.votes.filter((v) => v.value === -1);
      const activeOnly = g.votes.filter((v) => !v.song.isPlayed);
      const guestRequests = requestsByFp.get(g.fingerprint) || [];
      const guestAdded = addedByFp.get(g.fingerprint) || [];
      return {
        id: g.id,
        name: g.name,
        joinedAt: g.createdAt,
        // Lifetime counters (survive vote resets)
        totalUpvotes: g.totalUpvotes + currentUpvotes.length,
        totalDownvotes: g.totalDownvotes + currentDownvotes.length,
        totalVotes: g.totalUpvotes + g.totalDownvotes + g.votes.length,
        // Current active votes (only on unplayed songs still in queue)
        activeVotes: activeOnly.map((v) => ({
          trackName: v.song.trackName,
          artistName: v.song.artistName,
          albumArt: v.song.albumArt,
          value: v.value,
        })),
        // Songs they requested
        requests: guestRequests.map((r) => ({
          trackName: r.trackName,
          artistName: r.artistName,
          albumArt: r.albumArt,
          status: r.status,
        })),
        // Songs they added to the queue
        songsAdded: guestAdded.map((s) => ({
          trackName: s.trackName,
          artistName: s.artistName,
          albumArt: s.albumArt,
        })),
      };
    });

    return NextResponse.json({ count: guests.length, guests: detailed });
  }

  const count = await prisma.guest.count({
    where: { roomId: room.id, name: { not: "" } },
  });

  return NextResponse.json({ count });
}
