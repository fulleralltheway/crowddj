import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { setVolume } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

// Live drag-time volume push. Adjusts the Spotify device immediately without
// touching the session row. Settings slider commits the final value via PATCH
// /sessions/[id] on release; this endpoint exists so the slider can preview
// volume changes audibly while the user is dragging.
//
// Refuses while a fade is in flight (`fadingUntil > now`) so a slider drag
// can't fight a server-driven fade for the device volume.
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

  if (sess.fadingUntil && sess.fadingUntil.getTime() > Date.now()) {
    return NextResponse.json({ skipped: true, reason: "fade_in_progress" }, { status: 409 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const v = Number(body.volume);
  if (!Number.isFinite(v) || v < 0 || v > 100) {
    return NextResponse.json({ error: "volume must be 0-100" }, { status: 400 });
  }

  const accessToken = (auth_ as { accessToken?: string }).accessToken;
  if (!accessToken) {
    return NextResponse.json({ error: "no_token" }, { status: 401 });
  }

  try {
    await setVolume(accessToken, Math.round(v));
  } catch (e) {
    return NextResponse.json(
      { error: "set_volume_failed", detail: e instanceof Error ? e.message : "" },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true, volume: Math.round(v) });
}
