import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { resumePlayback, setVolume, transferPlayback } from "@/lib/spotify";
import { buildFadeCurve, runFadeStepsWithBudget } from "@/lib/fade-curve";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Spotify Connect deactivates an idle device after ~10–15 min of no
// heartbeat. After a long pause, PUT /me/player/play with no device_id
// returns 404 NO_ACTIVE_DEVICE. We attempt to wake the saved deviceId via
// transferPlayback and retry once before surfacing a structured error so
// the client can open the device picker instead of dumping a red banner.
async function resumeWithRecovery(
  accessToken: string,
  deviceId: string | null
): Promise<{ ok: true } | { ok: false; reason: "device_unavailable" | "resume_failed"; detail: string }> {
  try {
    await resumePlayback(accessToken);
    return { ok: true };
  } catch (firstErr) {
    if (!deviceId) {
      return { ok: false, reason: "resume_failed", detail: firstErr instanceof Error ? firstErr.message : "" };
    }
    try {
      await transferPlayback(accessToken, deviceId);
    } catch (transferErr) {
      const msg = transferErr instanceof Error ? transferErr.message : "";
      // Spotify reports device_unavailable when the saved deviceId is no
      // longer reachable on the network. Bubble that up so the picker opens.
      if (msg === "device_unavailable") {
        return { ok: false, reason: "device_unavailable", detail: "The saved playback device isn't reachable. Pick another device." };
      }
      return { ok: false, reason: "resume_failed", detail: msg };
    }
    // Spotify needs a beat after transferPlayback before it'll accept play.
    await sleep(500);
    try {
      await resumePlayback(accessToken);
      return { ok: true };
    } catch (retryErr) {
      return { ok: false, reason: "device_unavailable", detail: retryErr instanceof Error ? retryErr.message : "" };
    }
  }
}

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

  // Mark in-flight so the volume slider can't push live setVolume against the
  // fade-up. Auto-expires if the route crashes between set and clear.
  try {
    await prisma.bluegrassSession.update({
      where: { id: sess.id },
      data: { fadingUntil: new Date(Date.now() + fadeDurationMs + 3000) },
    });
  } catch {}

  // Start at 0 and resume, then ramp up. Reverse the down-curve to get an up-curve.
  try { await setVolume(accessToken, 0); } catch {}
  const resumeResult = await resumeWithRecovery(accessToken, sess.deviceId);
  if (!resumeResult.ok) {
    try {
      await prisma.bluegrassSession.update({
        where: { id: sess.id },
        data: { fadingUntil: null },
      });
    } catch {}
    // Restore audible volume so the user isn't stranded with the device
    // muted to 0% from the pre-resume setVolume(0) call. Best-effort.
    try { await setVolume(accessToken, sess.targetVolume); } catch {}
    return NextResponse.json(
      { error: resumeResult.reason, detail: resumeResult.detail },
      { status: 502 }
    );
  }

  try {
    const { multipliers, stepMs } = buildFadeCurve(fadeDurationMs);
    // multipliers ramps ~1 → 0 (down). For an up-ramp, walk it in reverse so
    // the multiplier we pass to setVolume goes 0 → ~1.
    const upMults = [...multipliers].reverse();
    await runFadeStepsWithBudget({
      multipliers: upMults,
      stepMs,
      budgetMs: fadeDurationMs,
      applyVolume: async (mult) => {
        try { await setVolume(accessToken, Math.round(target * mult)); } catch {}
      },
    });
    try { await setVolume(accessToken, target); } catch {}
  } finally {
    try {
      await prisma.bluegrassSession.update({
        where: { id: sess.id },
        data: { fadingUntil: null },
      });
    } catch {}
  }

  return NextResponse.json({ ok: true, target });
}
