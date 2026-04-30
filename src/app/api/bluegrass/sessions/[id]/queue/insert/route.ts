import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { assignSortOrders } from "@/lib/bluegrass-queue";
import { NextRequest, NextResponse } from "next/server";

const TRACK_URI_RE = /^spotify:track:[A-Za-z0-9]+$/;

type InsertBody = {
  uri?: string;
  name?: string;
  artist?: string;
  image?: string | null;
  durationMs?: number;
  position?: "next" | "end";
};

/**
 * Insert a track into the session's queue at "next" (right after the
 * currently-playing track) or "end" (after every other unplayed track).
 * Renumbers sortOrder so it stays gap-free.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth_ = await auth();
  if (!auth_?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const sess = await prisma.bluegrassSession.findUnique({ where: { id } });
  if (!sess || sess.userId !== auth_.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!sess.isActive) {
    return NextResponse.json({ error: "session_inactive" }, { status: 409 });
  }

  let body: InsertBody;
  try {
    body = (await req.json()) as InsertBody;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  if (!body.uri || !TRACK_URI_RE.test(body.uri)) {
    return NextResponse.json({ error: "invalid_uri" }, { status: 400 });
  }
  if (!body.name || !body.artist) {
    return NextResponse.json({ error: "missing_metadata" }, { status: 400 });
  }
  const position = body.position === "end" ? "end" : "next";
  const durationMs = Number.isFinite(body.durationMs) ? Math.max(0, body.durationMs as number) : 0;

  // Reject duplicates of unplayed tracks already queued.
  const dupe = await prisma.bluegrassSessionTrack.findFirst({
    where: { sessionId: id, spotifyUri: body.uri, isPlayed: false },
    select: { id: true },
  });
  if (dupe) {
    return NextResponse.json({ error: "already_queued", id: dupe.id }, { status: 409 });
  }

  // Compute the post-insert ordering of unplayed tracks.
  const existingUnplayed = await prisma.bluegrassSessionTrack.findMany({
    where: { sessionId: id, isPlayed: false },
    orderBy: { sortOrder: "asc" },
    select: { id: true, isPlaying: true },
  });

  const created = await prisma.bluegrassSessionTrack.create({
    data: {
      sessionId: id,
      spotifyUri: body.uri,
      trackName: body.name,
      artistName: body.artist,
      albumArt: body.image ?? null,
      durationMs,
      sortOrder: -1, // placeholder, fixed up by assignSortOrders below
      addedManually: true,
    },
  });

  // Build the new ordering of unplayed ids: [...beforeNew, newId, ...afterNew].
  let newOrder: string[];
  if (position === "next") {
    const playingIdx = existingUnplayed.findIndex((t) => t.isPlaying);
    if (playingIdx === -1) {
      // Nothing currently playing — insert at the front of the unplayed list.
      newOrder = [created.id, ...existingUnplayed.map((t) => t.id)];
    } else {
      newOrder = [
        ...existingUnplayed.slice(0, playingIdx + 1).map((t) => t.id),
        created.id,
        ...existingUnplayed.slice(playingIdx + 1).map((t) => t.id),
      ];
    }
  } else {
    newOrder = [...existingUnplayed.map((t) => t.id), created.id];
  }

  // Find the sortOrder of the LAST played track so unplayed numbering picks
  // up after it (keeps played + unplayed monotonic).
  const lastPlayed = await prisma.bluegrassSessionTrack.findFirst({
    where: { sessionId: id, isPlayed: true },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const startAt = (lastPlayed?.sortOrder ?? -1) + 1;
  await assignSortOrders(newOrder, startAt);

  const final = await prisma.bluegrassSessionTrack.findUnique({ where: { id: created.id } });
  return NextResponse.json(final, { status: 201 });
}
