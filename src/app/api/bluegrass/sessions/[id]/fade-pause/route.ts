import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getCurrentPlayback, pausePlayback, setVolume } from "@/lib/spotify";
import { buildFadeCurve } from "@/lib/fade-curve";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(
  _req: NextRequest,
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

  const accessToken = (auth_ as { accessToken?: string }).accessToken;
  if (!accessToken) {
    return NextResponse.json({ error: "no_token" }, { status: 401 });
  }

  const fadeDurationMs = Math.max(500, sess.fadeDurationSec * 1000);

  let originalVolume = sess.targetVolume;
  try {
    const playback = await getCurrentPlayback(accessToken);
    originalVolume = playback?.device?.volume_percent ?? sess.targetVolume;
  } catch {}

  const { multipliers, stepMs } = buildFadeCurve(fadeDurationMs);

  if (originalVolume < 10) {
    try { await pausePlayback(accessToken); } catch {}
    return NextResponse.json({ ok: true, fadedFrom: originalVolume, skipped: "already_quiet" });
  }

  // Mark in-flight so the volume slider can't push live setVolume against the
  // fade. Auto-expires if the route crashes between set and clear.
  try {
    await prisma.bluegrassSession.update({
      where: { id: sess.id },
      data: { fadingUntil: new Date(Date.now() + fadeDurationMs + 3000) },
    });
  } catch {}

  try {
    for (const mult of multipliers) {
      try { await setVolume(accessToken, Math.round(originalVolume * mult)); } catch {}
      await sleep(stepMs);
    }
    try { await setVolume(accessToken, 0); } catch {}
    try { await pausePlayback(accessToken); } catch {}
  } finally {
    try {
      await prisma.bluegrassSession.update({
        where: { id: sess.id },
        data: { fadingUntil: null },
      });
    } catch {}
  }

  return NextResponse.json({ ok: true, fadedFrom: originalVolume });
}
