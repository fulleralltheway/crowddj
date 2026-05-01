import { prisma } from "@/lib/db";
import { getCurrentPlayback } from "@/lib/spotify";
import { decideSyncStatus, type SyncDecision } from "@/lib/bluegrass-sync";
import { NextRequest, NextResponse } from "next/server";

// Same ceiling as bluegrass-fade-transition. With deferFade=false the cron
// awaits the in-process fade endpoint; that endpoint can take up to ~10s
// per session (fade ramp + restoreVolume retries). 60s gives headroom for
// up to ~5 concurrent active sessions before risking a Vercel timeout.
export const maxDuration = 60;

// Orphan reaper thresholds. A session row stays isActive=true forever unless
// the operator taps End Session — closing the tab leaves a zombie that the
// cron keeps polling against Spotify (~1 call/min via Vercel + ~6/min via the
// Fly.io socket server). These two checks auto-close stale rows so the
// polling pipeline drains itself.
//
// IDLE_CLOSE_MS: how long Spotify must report "no playback" before we treat
// the session as abandoned. 60 min keeps real-world coffee breaks safe.
// WALL_CLOCK_MAX_MS: hard cap from session creation. Catches the case where
// Spotify *is* still playing somehow (looped playlist, autoplay) but no
// human is operating it. 12h is well past any plausible class.
const IDLE_CLOSE_MS = 60 * 60 * 1000;
const WALL_CLOCK_MAX_MS = 12 * 60 * 60 * 1000;

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
    // Wall-clock cap: any session older than WALL_CLOCK_MAX_MS gets reaped
    // regardless of playback state. Comes BEFORE the token + Spotify calls
    // so a runaway session can't keep burning cycles even if the operator's
    // Spotify token is healthy.
    if (Date.now() - sess.createdAt.getTime() > WALL_CLOCK_MAX_MS) {
      await prisma.bluegrassSession.update({
        where: { id: sess.id },
        data: { isActive: false, closedAt: new Date(), fadingUntil: null, noPlaybackSince: null },
      });
      results.push({ id: sess.id, status: "session_ended" });
      continue;
    }

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

    // Scheduled stops: any unfired stop whose stopAt has passed should fire.
    // Firing means (a) marking the row fired so it doesn't loop, and (b)
    // flipping stopAfterCurrent IF music is actively playing right now —
    // otherwise the operator already paused for an early announcement and
    // we'd be queueing up a phantom stop on the next track they play.
    // If `playback` is null (Spotify API hiccup) we skip the whole block so
    // the next tick retries with a definitive playback state — better to
    // fire a few seconds late than fire incorrectly while paused.
    if (playback) {
      const due = await prisma.bluegrassScheduledStop.findMany({
        where: { sessionId: sess.id, fired: false, stopAt: { lte: new Date() } },
        select: { id: true },
      });
      if (due.length > 0) {
        await prisma.bluegrassScheduledStop.updateMany({
          where: { id: { in: due.map((d) => d.id) } },
          data: { fired: true, firedAt: new Date() },
        });
        if (playback.is_playing === true && !sess.stopAfterCurrent) {
          // updateMany with the false-guard avoids a no-op write when the
          // operator already toggled it manually.
          await prisma.bluegrassSession.updateMany({
            where: { id: sess.id, stopAfterCurrent: false },
            data: { stopAfterCurrent: true },
          });
          sess.stopAfterCurrent = true;
        }
      }
    }

    const decision = decideSyncStatus(sess, playback);

    // Idle reaper: if Spotify reports nothing playing (paused, stopped, or no
    // active device), start a streak timer; close the session when the streak
    // hits IDLE_CLOSE_MS. Any non-idle status clears the streak so a brief
    // pause for an announcement doesn't accumulate. `playback` being null
    // (Spotify API hiccup) is treated like idle for streak-counting purposes —
    // self-corrects on the next tick if it was transient.
    if (decision.status === "no_playback") {
      if (sess.noPlaybackSince) {
        if (Date.now() - sess.noPlaybackSince.getTime() >= IDLE_CLOSE_MS) {
          await prisma.bluegrassSession.update({
            where: { id: sess.id },
            data: { isActive: false, closedAt: new Date(), fadingUntil: null, noPlaybackSince: null },
          });
          results.push({ id: sess.id, status: "session_ended" });
          continue;
        }
      } else {
        await prisma.bluegrassSession.update({
          where: { id: sess.id },
          data: { noPlaybackSince: new Date() },
        });
        sess.noPlaybackSince = new Date();
      }
    } else if (sess.noPlaybackSince) {
      // Streak broken — clear the marker so future idle stretches start fresh.
      await prisma.bluegrassSession.update({
        where: { id: sess.id },
        data: { noPlaybackSince: null },
      });
      sess.noPlaybackSince = null;
    }

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
