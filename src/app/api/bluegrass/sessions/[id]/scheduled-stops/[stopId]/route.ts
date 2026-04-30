import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

/**
 * Delete a scheduled stop. Allowed at any time — even fired stops can be
 * removed (e.g. operator wants to clean up the audit record). The cron's
 * "fired = true" check means deleting a stop AFTER it's fired has no
 * downstream effect.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; stopId: string }> }
) {
  const auth_ = await auth();
  if (!auth_?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id, stopId } = await params;

  // Validate ownership via the parent session in a single query: the stop
  // must belong to the session AND the session must belong to the user.
  // Direct deleteMany with a nested where avoids a load+delete round trip.
  const result = await prisma.bluegrassScheduledStop.deleteMany({
    where: {
      id: stopId,
      sessionId: id,
      session: { userId: auth_.user.id },
    },
  });
  if (result.count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
