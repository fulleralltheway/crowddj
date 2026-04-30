import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { executeFadeTransition } from "@/lib/bluegrass-fade";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

/**
 * Session-scoped fade + advance, used by the client-polling threshold
 * fallback when the socket isn't pushing precise schedules (PWA on iOS
 * loses the socket on background; this is the path that runs there).
 *
 * Mirrors the cron-driven /api/cron/bluegrass-fade-transition route but
 * authenticates via the user's session instead of CRON_SECRET. The actual
 * fade logic is shared via src/lib/bluegrass-fade.ts so the cron-driven and
 * client-driven paths stay in lockstep — divergence between them is exactly
 * how the "stop-after-current restarts at top of playlist" bug shipped on
 * 2026-04-29.
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
  const sess = await prisma.bluegrassSession.findUnique({ where: { id } });
  if (!sess || sess.userId !== auth_.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const accessToken = (auth_ as { accessToken?: string }).accessToken;
  if (!accessToken) {
    return NextResponse.json({ error: "no_token" }, { status: 401 });
  }

  let expectedTrackUri: string | undefined;
  try {
    const body = await req.json();
    if (typeof body?.expectedTrackUri === "string") expectedTrackUri = body.expectedTrackUri;
  } catch {
    // Empty body is fine — expectedTrackUri is optional.
  }

  const result = await executeFadeTransition(sess, accessToken, expectedTrackUri);
  if ("error" in result) {
    return NextResponse.json({ error: result.error, detail: result.detail }, { status: result.status });
  }
  return NextResponse.json(result);
}
