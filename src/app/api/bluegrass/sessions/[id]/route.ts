import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getCurrentPlayback, pausePlayback, setVolume, transferPlayback } from "@/lib/spotify";
import { buildFadeCurve } from "@/lib/fade-curve";
import { NextRequest, NextResponse } from "next/server";

// DELETE runs a gentle volume-restore ramp; give it room past Vercel's 10s default.
export const maxDuration = 60;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(n)));
}

async function loadOwnedSession(id: string, userId: string) {
  const sess = await prisma.bluegrassSession.findUnique({ where: { id } });
  if (!sess || sess.userId !== userId) return null;
  return sess;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth_ = await auth();
  if (!auth_?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const sess = await loadOwnedSession(id, auth_.user.id);
  if (!sess) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(sess);
}

export async function PATCH(
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

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const data: Record<string, unknown> = {};

  if ("maxSongDurationSec" in body) {
    const v = Number(body.maxSongDurationSec);
    if (!Number.isFinite(v) || v < 0 || v > 600) {
      return NextResponse.json({ error: "maxSongDurationSec must be 0-600 (0 = off)" }, { status: 400 });
    }
    data.maxSongDurationSec = clamp(v, 0, 600);
  }
  if ("fadeDurationSec" in body) {
    const v = Number(body.fadeDurationSec);
    if (!Number.isFinite(v) || v < 1 || v > 30) {
      return NextResponse.json({ error: "fadeDurationSec must be 1-30" }, { status: 400 });
    }
    data.fadeDurationSec = clamp(v, 1, 30);
  }
  if ("targetVolume" in body) {
    const v = Number(body.targetVolume);
    if (!Number.isFinite(v) || v < 0 || v > 100) {
      return NextResponse.json({ error: "targetVolume must be 0-100" }, { status: 400 });
    }
    data.targetVolume = clamp(v, 0, 100);
  }
  if ("stopAfterCurrent" in body) {
    data.stopAfterCurrent = Boolean(body.stopAfterCurrent);
  }
  if ("deviceId" in body) {
    data.deviceId = body.deviceId === null ? null : String(body.deviceId).slice(0, 200);
  }
  if ("playlistUri" in body) {
    const uri = String(body.playlistUri);
    if (!/^spotify:playlist:[A-Za-z0-9]+$/.test(uri)) {
      return NextResponse.json({ error: "playlistUri must be spotify:playlist:*" }, { status: 400 });
    }
    data.playlistUri = uri;
  }
  if ("playlistName" in body) {
    const name = String(body.playlistName);
    if (!name || name.length > 200) {
      return NextResponse.json({ error: "playlistName required (≤200 chars)" }, { status: 400 });
    }
    data.playlistName = name;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No valid fields" }, { status: 400 });
  }

  // Enforce max >= 3 * fade (or max=0 = auto-fade off). Without this, the
  // wall-time cooldown guard on lastSyncAdvance silently drops every
  // consecutive auto-fade once max < 2*fade. 3x leaves headroom.
  const newMax = "maxSongDurationSec" in data ? (data.maxSongDurationSec as number) : sess.maxSongDurationSec;
  const newFade = "fadeDurationSec" in data ? (data.fadeDurationSec as number) : sess.fadeDurationSec;
  if (newMax > 0 && newMax < 3 * newFade) {
    return NextResponse.json(
      {
        error: "max_too_short_for_fade",
        detail: `maxSongDurationSec (${newMax}) must be at least 3× fadeDurationSec (${newFade}). Lower the fade or raise the max.`,
      },
      { status: 400 }
    );
  }

  // Device picker UX: when deviceId changes to a non-null value, actively
  // transfer Spotify Connect playback to the new target instead of just
  // recording the preference for the next fade-transition. Without the
  // transfer, the picker silently appears not to do anything until the
  // next song change, which reads as a broken control. The transfer
  // preserves playback state — playing devices keep playing on the new
  // target, paused devices stay paused. Failure here aborts the whole
  // PATCH so the DB and Spotify don't drift.
  if (
    "deviceId" in data &&
    data.deviceId &&
    data.deviceId !== sess.deviceId
  ) {
    const accessToken = (auth_ as { accessToken?: string }).accessToken;
    if (!accessToken) {
      return NextResponse.json({ error: "no_token" }, { status: 401 });
    }
    try {
      await transferPlayback(accessToken, data.deviceId as string);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "transfer_failed";
      const status = msg === "device_unavailable" ? 404 : 502;
      return NextResponse.json(
        {
          error: msg,
          detail:
            msg === "device_unavailable"
              ? "That device isn't reachable right now. Open Spotify on it briefly so it appears as active, then try again."
              : "Spotify rejected the device transfer.",
        },
        { status }
      );
    }
  }

  // Lowering maxSongDurationSec or fadeDurationSec mid-song can leave the
  // current track already past the (newly-shorter) threshold, which would
  // chop it off in the next 2s poll. Bump lastSyncAdvance so the cooldown
  // guard suppresses an immediate fire — the new value applies to the NEXT
  // transition, which is the intuitive expectation.
  if (
    ("maxSongDurationSec" in data && newMax < sess.maxSongDurationSec) ||
    ("fadeDurationSec" in data && newFade !== sess.fadeDurationSec)
  ) {
    data.lastSyncAdvance = new Date();
  }

  const updated = await prisma.bluegrassSession.update({
    where: { id },
    data,
  });
  return NextResponse.json(updated);
}

/**
 * Kill switch. Restores device volume to target, pauses playback, marks session
 * inactive. Best-effort on Spotify ops — DB state must always update so the
 * socket server's next sync tick sees isActive=false and stops syncing.
 */
export async function DELETE(
  _req: NextRequest,
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
    return NextResponse.json({ ok: true, alreadyInactive: true });
  }

  const accessToken = (auth_ as { accessToken?: string }).accessToken;
  let restoredFromVolume: number | null = null;

  if (accessToken) {
    try {
      const playback = await getCurrentPlayback(accessToken);
      const currentVol = playback?.device?.volume_percent ?? sess.targetVolume;
      restoredFromVolume = currentVol;

      // If volume was driven down by a fade, ramp it back up so personal
      // Spotify use afterward doesn't start at near-zero.
      if (currentVol < sess.targetVolume - 5) {
        const rampMs = Math.min(2000, sess.fadeDurationSec * 1000);
        // Block live-volume during the ramp so a settings drag mid-DELETE
        // doesn't fight the restore.
        try {
          await prisma.bluegrassSession.update({
            where: { id: sess.id },
            data: { fadingUntil: new Date(Date.now() + rampMs + 1000) },
          });
        } catch {}
        const { multipliers, stepMs } = buildFadeCurve(rampMs);
        // multipliers ramps DOWN from 1→0; for an UP ramp, traverse reversed.
        const upMults = [...multipliers].reverse();
        for (const mult of upMults) {
          try {
            await setVolume(accessToken, currentVol + Math.round((sess.targetVolume - currentVol) * mult));
          } catch {}
          await sleep(stepMs);
        }
        try { await setVolume(accessToken, sess.targetVolume); } catch {}
      } else {
        try { await setVolume(accessToken, sess.targetVolume); } catch {}
      }

      try { await pausePlayback(accessToken); } catch {}
    } catch {
      // Silent — DB update below is the authoritative cleanup.
    }
  }

  const updated = await prisma.bluegrassSession.update({
    where: { id },
    data: { isActive: false, closedAt: new Date(), fadingUntil: null },
  });

  return NextResponse.json({ ok: true, session: updated, restoredFromVolume });
}
