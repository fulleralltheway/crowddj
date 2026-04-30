import { prisma } from "@/lib/db";
import { executeFadeTransition } from "@/lib/bluegrass-fade";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header = req.headers.get("authorization");
  if (header === `Bearer ${expected}`) return true;
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

/**
 * Server-side fade + advance for a Bluegrass session, called by the socket
 * server (precise-scheduled timer) or by sync-bluegrass with deferFade=false
 * (Vercel Cron fallback). The actual fade logic lives in
 * src/lib/bluegrass-fade.ts and is shared with the session-scoped
 * /fade-transition route — see that file for the full sequence.
 */
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { sessionId?: string; expectedTrackUri?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (!body.sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }

  const sess = await prisma.bluegrassSession.findUnique({ where: { id: body.sessionId } });
  if (!sess) return NextResponse.json({ error: "Session not found" }, { status: 404 });

  const account = await prisma.account.findFirst({
    where: { userId: sess.userId, provider: "spotify" },
  });
  if (!account?.access_token) {
    return NextResponse.json({ error: "no_token" }, { status: 401 });
  }
  const accessToken = await getAccessToken(account);
  if (!accessToken) {
    return NextResponse.json({ error: "token_refresh_failed" }, { status: 401 });
  }

  const result = await executeFadeTransition(sess, accessToken, body.expectedTrackUri);
  if ("error" in result) {
    return NextResponse.json({ error: result.error, detail: result.detail }, { status: result.status });
  }
  return NextResponse.json(result);
}
