import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { startPlaybackContext, pausePlayback, setVolume } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Park Spotify on track 1 of the chosen playlist, paused, so the now-playing
// card has a real track to display before the first Play tap. Forces Spotify
// off whatever was playing elsewhere and onto the session's playlist context,
// then immediately pauses. The brief un-pause is muted so the room stays quiet.
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

  // Mute first so the brief audio between start and pause is silent.
  try { await setVolume(accessToken, 0); } catch {}

  try {
    await startPlaybackContext(accessToken, sess.playlistUri, sess.deviceId, { position: 0 });
  } catch (e) {
    // Restore volume so a later /play call doesn't start at 0.
    try { await setVolume(accessToken, sess.targetVolume); } catch {}
    const msg = e instanceof Error ? e.message : "playback_failed";
    if (msg === "device_unavailable") {
      return NextResponse.json(
        { error: "device_unavailable", detail: "Open Spotify on the laptop and try again." },
        { status: 404 }
      );
    }
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // Give Spotify a moment to register the new context before pausing —
  // without this, pause occasionally lands before play and the track keeps
  // playing.
  await sleep(400);
  try { await pausePlayback(accessToken); } catch {}

  // Restore target volume so /fade-resume's 0→target ramp lands correctly.
  try { await setVolume(accessToken, sess.targetVolume); } catch {}

  return NextResponse.json({ ok: true });
}
