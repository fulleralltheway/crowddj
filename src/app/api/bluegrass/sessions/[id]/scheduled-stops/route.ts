import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

const MAX_STOPS_PER_SESSION = 20;
const MAX_LABEL_LEN = 80;

async function loadOwnedSession(id: string, userId: string) {
  const sess = await prisma.bluegrassSession.findUnique({
    where: { id },
    select: { id: true, userId: true, isActive: true },
  });
  if (!sess || sess.userId !== userId) return null;
  return sess;
}

/**
 * Create a scheduled stop. The cron sync flips the session's
 * stopAfterCurrent flag at this wall-clock time — but only if music is
 * actively playing at that moment, otherwise the stop is treated as
 * already-handled (operator paused early for the announcement). See
 * src/app/api/cron/sync-bluegrass/route.ts for the firing logic.
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
  const sess = await loadOwnedSession(id, auth_.user.id);
  if (!sess) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!sess.isActive) {
    return NextResponse.json({ error: "session_inactive" }, { status: 409 });
  }

  let body: { stopAt?: string; label?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  if (!body.stopAt || typeof body.stopAt !== "string") {
    return NextResponse.json({ error: "stopAt required (ISO string)" }, { status: 400 });
  }
  const stopAt = new Date(body.stopAt);
  if (Number.isNaN(stopAt.getTime())) {
    return NextResponse.json({ error: "stopAt must be a valid ISO date" }, { status: 400 });
  }
  // 5s grace so a "set for 9:45" tap that lands at 9:45:00.4 still saves.
  if (stopAt.getTime() < Date.now() - 5000) {
    return NextResponse.json({ error: "stopAt must be in the future" }, { status: 400 });
  }

  let label: string | null = null;
  if (body.label != null) {
    const trimmed = String(body.label).trim();
    if (trimmed.length > MAX_LABEL_LEN) {
      return NextResponse.json(
        { error: `label must be ≤${MAX_LABEL_LEN} chars` },
        { status: 400 }
      );
    }
    label = trimmed || null;
  }

  // Cap unfired-stop count per session as a sanity guard against runaway UI
  // taps. Fired stops don't count — they're audit trail only.
  const unfiredCount = await prisma.bluegrassScheduledStop.count({
    where: { sessionId: id, fired: false },
  });
  if (unfiredCount >= MAX_STOPS_PER_SESSION) {
    return NextResponse.json(
      { error: `max ${MAX_STOPS_PER_SESSION} pending stops per session` },
      { status: 400 }
    );
  }

  const created = await prisma.bluegrassScheduledStop.create({
    data: { sessionId: id, stopAt, label },
  });
  return NextResponse.json(created, { status: 201 });
}
