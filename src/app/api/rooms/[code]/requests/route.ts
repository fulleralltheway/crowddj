import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

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
    const maxOrder = await prisma.roomSong.findFirst({
      where: { roomId: room.id },
      orderBy: { sortOrder: "desc" },
    });

    await prisma.roomSong.create({
      data: {
        roomId: room.id,
        spotifyUri: songRequest.spotifyUri,
        trackName: songRequest.trackName,
        artistName: songRequest.artistName,
        albumArt: songRequest.albumArt,
        durationMs: songRequest.durationMs,
        sortOrder: (maxOrder?.sortOrder ?? -1) + 1,
        addedBy: songRequest.requestedBy,
      },
    });
  }

  return NextResponse.json({ success: true });
}
