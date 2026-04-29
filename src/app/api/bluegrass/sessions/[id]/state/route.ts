import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getCurrentPlayback } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
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

  const accessToken = (auth_ as { accessToken?: string }).accessToken;
  if (!accessToken) {
    return NextResponse.json({ error: "no_token" }, { status: 401 });
  }

  const playback = await getCurrentPlayback(accessToken).catch(() => null);
  if (!playback || !playback.item) {
    return NextResponse.json({ trackName: null, isPlaying: false });
  }

  return NextResponse.json({
    trackName: playback.item.name,
    artistName: (playback.item.artists ?? []).map((a: { name: string }) => a.name).join(", "),
    albumArt: playback.item.album?.images?.[0]?.url ?? null,
    durationMs: playback.item.duration_ms,
    positionMs: playback.progress_ms ?? 0,
    isPlaying: !!playback.is_playing,
    deviceId: playback.device?.id ?? null,
    deviceVolume: playback.device?.volume_percent ?? null,
    trackUri: playback.item.uri,
  });
}
