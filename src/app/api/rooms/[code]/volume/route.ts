import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { setVolume } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const accessToken = (session as any).accessToken;
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.hostId !== session.user.id) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const volume = Math.max(0, Math.min(100, Number(body.volume) || 80));
    await setVolume(accessToken, volume);
    return NextResponse.json({ success: true, volume });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Failed to set volume" }, { status: 500 });
  }
}
