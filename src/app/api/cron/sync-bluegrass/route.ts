import { prisma } from "@/lib/db";
import { getCurrentPlayback } from "@/lib/spotify";
import { decideSyncStatus, type SyncDecision } from "@/lib/bluegrass-sync";
import { NextRequest, NextResponse } from "next/server";

// Same ceiling as bluegrass-fade-transition. With deferFade=false the cron
// awaits the in-process fade endpoint; that endpoint can take up to ~10s
// per session (fade ramp + restoreVolume retries). 60s gives headroom for
// up to ~5 concurrent active sessions before risking a Vercel timeout.
export const maxDuration = 60;

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  // Vercel Cron sends Authorization: Bearer <CRON_SECRET>
  const header = req.headers.get("authorization");
  if (header === `Bearer ${expected}`) return true;
  // Socket server passes ?secret= so we don't break the existing pattern.
  const param = req.nextUrl.searchParams.get("secret");
  return param === expected;
}

async function getAccessToken(account: {
  id: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
}): Promise<string | null> {
  if (!account.access_token) return null;
  if (!account.expires_at || account.expires_at * 1000 > Date.now()) {
    return account.access_token;
  }
  if (!account.refresh_token) return null;
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(
        `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
      ).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: account.refresh_token }),
  });
  const tokens = await res.json();
  if (!res.ok) return null;
  await prisma.account.update({
    where: { id: account.id },
    data: {
      access_token: tokens.access_token,
      expires_at: Math.floor(Date.now() / 1000 + tokens.expires_in),
      refresh_token: tokens.refresh_token ?? account.refresh_token,
    },
  });
  return tokens.access_token;
}

async function fireFade(req: NextRequest, sessionId: string, expectedTrackUri: string | undefined) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;
  const url = `${req.nextUrl.origin}/api/cron/bluegrass-fade-transition?secret=${encodeURIComponent(secret)}`;
  const body: Record<string, string> = { sessionId };
  if (expectedTrackUri) body.expectedTrackUri = expectedTrackUri;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Default deferFade=false so the Vercel Cron path (no query string — Vercel
  // strips them from cron paths) hits the synchronous-fade fallback. The
  // socket server explicitly opts into precise scheduling with `?deferFade=true`.
  const deferFade = req.nextUrl.searchParams.get("deferFade") === "true";
  const sessionIdsParam = req.nextUrl.searchParams.get("sessionIds");

  const where: { isActive: boolean; id?: { in: string[] } } = { isActive: true };
  if (sessionIdsParam) {
    const ids = sessionIdsParam.split(",").filter(Boolean);
    if (ids.length > 0) where.id = { in: ids };
  }

  const sessions = await prisma.bluegrassSession.findMany({ where });

  // Report any IDs the caller asked about that aren't active anymore.
  const results: ({ id: string } & SyncDecision)[] = [];
  if (sessionIdsParam) {
    const found = new Set(sessions.map((s) => s.id));
    for (const id of sessionIdsParam.split(",").filter(Boolean)) {
      if (!found.has(id)) results.push({ id, status: "session_ended" });
    }
  }

  // Collect fade-fire promises; Promise.all at the end so multiple sessions
  // with simultaneous threshold hits don't serialize into a maxDuration
  // overrun. Vercel kills background work after response, so we must await.
  const firePromises: Promise<unknown>[] = [];

  for (const sess of sessions) {
    const account = await prisma.account.findFirst({
      where: { userId: sess.userId, provider: "spotify" },
    });
    if (!account?.access_token) {
      results.push({ id: sess.id, status: "no_playback" });
      continue;
    }

    const accessToken = await getAccessToken(account);
    if (!accessToken) {
      results.push({ id: sess.id, status: "no_playback" });
      continue;
    }

    let playback = null;
    try {
      playback = await getCurrentPlayback(accessToken);
    } catch {
      // Treat fetch failure like no_playback; next tick will retry.
    }

    const decision = decideSyncStatus(sess, playback);

    // Track current track URI + start time for our own audit trail. Only
    // update when the URI actually changes — same URI means same track,
    // and we don't want to reset trackStartedAt when polling mid-song.
    // Also reconcile deviceId on every tick: when the user moves Spotify
    // playback to a different Connect target (Mac → iPhone → speaker),
    // sess.deviceId is otherwise stuck on the original device and the
    // next fade calls startPlaybackContext against a dead/wrong target.
    const sessUpdate: { currentTrackUri?: string; trackStartedAt?: Date; deviceId?: string } = {};
    if (decision.currentTrackUri && decision.currentTrackUri !== sess.currentTrackUri) {
      sessUpdate.currentTrackUri = decision.currentTrackUri;
      sessUpdate.trackStartedAt = new Date();
    }
    if (decision.deviceId && decision.deviceId !== sess.deviceId) {
      sessUpdate.deviceId = decision.deviceId;
    }
    if (Object.keys(sessUpdate).length > 0) {
      await prisma.bluegrassSession.update({
        where: { id: sess.id },
        data: sessUpdate,
      });
    }

    // Cron-fallback path: when deferFade=false and we're past threshold,
    // fire the fade. fade-transition has its own concurrency guard so this
    // is safe even if multiple cron ticks land in the same window.
    if (!deferFade && decision.status === "needs_fade") {
      firePromises.push(fireFade(req, sess.id, decision.currentTrackUri));
      results.push({ id: sess.id, status: "needs_fade", fadeDurationMs: decision.fadeDurationMs, currentTrackUri: decision.currentTrackUri });
      continue;
    }

    results.push({ id: sess.id, ...decision });
  }

  if (firePromises.length > 0) {
    await Promise.all(firePromises);
  }

  return NextResponse.json({ results });
}
