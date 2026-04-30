import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth_ = await auth();
  if (!auth_?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const sess = await prisma.bluegrassSession.findUnique({
    where: { id },
    select: { id: true, userId: true, tracksImported: true, currentTrackUri: true },
  });
  if (!sess || sess.userId !== auth_.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const tracks = await prisma.bluegrassSessionTrack.findMany({
    where: { sessionId: id },
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      spotifyUri: true,
      trackName: true,
      artistName: true,
      albumArt: true,
      durationMs: true,
      sortOrder: true,
      isPlaying: true,
      isPlayed: true,
      addedManually: true,
    },
  });

  return NextResponse.json({
    tracksImported: sess.tracksImported,
    currentTrackUri: sess.currentTrackUri,
    queue: tracks,
  });
}
