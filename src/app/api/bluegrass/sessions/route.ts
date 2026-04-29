import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

const PLAYLIST_URI_RE = /^spotify:playlist:[A-Za-z0-9]+$/;

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const active = await prisma.bluegrassSession.findFirst({
    where: { userId: session.user.id, isActive: true },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(active);
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { playlistUri?: string; playlistName?: string; deviceId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  if (!body.playlistUri || !PLAYLIST_URI_RE.test(body.playlistUri)) {
    return NextResponse.json({ error: "playlistUri must be a spotify:playlist:* URI" }, { status: 400 });
  }
  if (!body.playlistName || body.playlistName.length > 200) {
    return NextResponse.json({ error: "playlistName required (≤200 chars)" }, { status: 400 });
  }

  const existing = await prisma.bluegrassSession.findFirst({
    where: { userId: session.user.id, isActive: true },
  });
  if (existing) {
    return NextResponse.json(
      { error: "session_already_active", id: existing.id },
      { status: 409 }
    );
  }

  const created = await prisma.bluegrassSession.create({
    data: {
      userId: session.user.id,
      playlistUri: body.playlistUri,
      playlistName: body.playlistName,
      deviceId: body.deviceId ?? null,
    },
  });

  return NextResponse.json(created, { status: 201 });
}
