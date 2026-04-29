import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getCurrentPlayback, setVolume, skipToNext } from "@/lib/spotify";
import { buildFadeCurve } from "@/lib/fade-curve";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function restoreVolume(accessToken: string, target: number, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await setVolume(accessToken, target);
      await sleep(500);
      const check = await getCurrentPlayback(accessToken);
      const actual = check?.device?.volume_percent ?? 0;
      if (actual >= target - 10) return;
    } catch {}
    await sleep(1000);
  }
  try { await setVolume(accessToken, target); } catch {}
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

  // Concurrency guard against client-polling fallback + socket-driven cron
  // racing on the same threshold. Atomic check-and-set on lastSyncAdvance.
  const cooldownCutoff = new Date(Date.now() - 2 * fadeDurationMs);
  const claimed = await prisma.bluegrassSession.updateMany({
    where: { id: sess.id, lastSyncAdvance: { lt: cooldownCutoff } },
    data: { lastSyncAdvance: new Date() },
  });
  if (claimed.count === 0) {
    return NextResponse.json({ skipped: true, reason: "concurrent_transition_in_flight" });
  }

  let originalVolume = sess.targetVolume;
  try {
    const playback = await getCurrentPlayback(accessToken);
    originalVolume = playback?.device?.volume_percent ?? sess.targetVolume;
  } catch {}

  const { multipliers, stepMs } = buildFadeCurve(fadeDurationMs);

  // Fade out, but never below 0
  if (originalVolume >= 10) {
    for (const mult of multipliers) {
      try { await setVolume(accessToken, Math.round(originalVolume * mult)); } catch {}
      await sleep(stepMs);
    }
    try { await setVolume(accessToken, 0); } catch {}
  }

  // Skip on the playlist context. skipToNext is acceptable here because we're
  // playing a vanilla playlist with no reorder semantics — Spotify's native
  // playlist ordering is the source of truth.
  try { await skipToNext(accessToken); } catch (e) {
    // Hard to recover from; restore volume so the user isn't stuck quiet.
    await restoreVolume(accessToken, originalVolume || sess.targetVolume);
    return NextResponse.json(
      { error: "skip_failed", detail: e instanceof Error ? e.message : "" },
      { status: 502 }
    );
  }

  // Give Spotify a moment to load the next track, then restore volume.
  await sleep(300);
  await restoreVolume(accessToken, sess.targetVolume);

  // lastSyncAdvance was already set by the concurrency guard above.
  await prisma.bluegrassSession.update({
    where: { id },
    data: { trackStartedAt: new Date(), currentTrackUri: null },
  });

  return NextResponse.json({ ok: true, fadedFrom: originalVolume });
}
