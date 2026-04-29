import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { startPlaybackContext, setVolume } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

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

  if (!sess.deviceId) {
    return NextResponse.json({ error: "device_not_selected" }, { status: 400 });
  }

  try {
    // Always start at position 0 of the playlist. Without an explicit offset,
    // Spotify resumes from a remembered cursor for that context — and when
    // switching FROM a different context, this sometimes manifests as "the
    // previous track keeps playing" because Spotify treats the call as a
    // no-op against its current state.
    await startPlaybackContext(accessToken, sess.playlistUri, sess.deviceId, { position: 0 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "playback_failed";
    if (msg === "device_unavailable") {
      return NextResponse.json(
        { error: "device_unavailable", detail: "Open Spotify on the laptop and try again." },
        { status: 404 }
      );
    }
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // Best-effort volume set; Spotify needs a moment after startPlayback before
  // setVolume reliably lands.
  try { await setVolume(accessToken, sess.targetVolume); } catch {}

  // Only update trackStartedAt — DO NOT touch lastSyncAdvance here. That
  // field gates the fade-transition cooldown guard; setting it now would
  // make the first auto-fade after Play look like a double-fire when
  // 2 * fadeDurationMs >= maxSongDurationMs (e.g. fade=6, max=15).
  await prisma.bluegrassSession.update({
    where: { id },
    data: { trackStartedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
