import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { resumePlayback, setVolume } from "@/lib/spotify";
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
  const target = sess.targetVolume;

  // Start at 0 and resume, then ramp up. Reverse the down-curve to get an up-curve.
  try { await setVolume(accessToken, 0); } catch {}
  try { await resumePlayback(accessToken); } catch (e) {
    return NextResponse.json({ error: "resume_failed", detail: e instanceof Error ? e.message : "" }, { status: 502 });
  }

  const { multipliers, stepMs } = buildFadeCurve(fadeDurationMs);
  // multipliers ramps ~1 → 0 (down). For an up-ramp, walk it in reverse so
  // the multiplier we pass to setVolume goes 0 → ~1.
  const upMults = [...multipliers].reverse();
  for (const mult of upMults) {
    try { await setVolume(accessToken, Math.round(target * mult)); } catch {}
    await sleep(stepMs);
  }
  try { await setVolume(accessToken, target); } catch {}

  return NextResponse.json({ ok: true, target });
}
