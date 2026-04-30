import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

const SPOTIFY_API = "https://api.spotify.com/v1";
export const maxDuration = 60;

type SpotifyTrackItem = {
  track: {
    uri?: string;
    name?: string;
    is_local?: boolean;
    duration_ms?: number;
    artists?: { name: string }[];
    album?: { images?: { url: string }[] };
  } | null;
};

/**
 * Idempotent one-shot import: fetch every track in the session's playlist
 * via /v1/playlists/{id}/tracks (paginated) and populate
 * BluegrassSessionTrack rows. Re-running deletes existing rows and re-imports.
 *
 * After import, fade-skip and bluegrass-fade-transition look up the next
 * track via the DB (`getNextSessionTrack`) instead of refetching from
 * Spotify. That's the architectural fix — no more per-skip metadata calls.
 */
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

  const playlistId = sess.playlistUri.replace(/^spotify:playlist:/, "");

  await prisma.bluegrassSession.update({
    where: { id },
    data: { tracksImported: "importing" },
  });

  // Paginate through /v1/playlists/{id}/tracks. 100 items per page (Spotify max).
  const tracks: { spotifyUri: string; trackName: string; artistName: string; albumArt: string | null; durationMs: number }[] = [];
  let url: string | null = `${SPOTIFY_API}/playlists/${playlistId}/tracks?limit=100&fields=next,items(track(uri,name,is_local,duration_ms,artists(name),album(images)))`;

  while (url) {
    const res: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      await prisma.bluegrassSession.update({
        where: { id },
        data: { tracksImported: "failed" },
      });
      if (res.status === 429) {
        const retryAfterRaw = res.headers.get("retry-after");
        const retryAfter = retryAfterRaw ? Math.max(1, Math.min(3600, parseInt(retryAfterRaw, 10) || 60)) : 60;
        return NextResponse.json(
          {
            error: "spotify_rate_limited",
            status: 429,
            retryAfterSec: retryAfter,
            detail: `Spotify rate-limited the playlist import. Retry in ${retryAfter}s.`,
          },
          { status: 429, headers: { "Retry-After": String(retryAfter) } }
        );
      }
      return NextResponse.json(
        { error: "import_failed", status: res.status, detail: `Spotify ${res.status}` },
        { status: 502 }
      );
    }
    const data = (await res.json()) as { next: string | null; items: SpotifyTrackItem[] };
    for (const item of data.items ?? []) {
      const t = item.track;
      if (!t || t.is_local || !t.uri || !t.name) continue;
      tracks.push({
        spotifyUri: t.uri,
        trackName: t.name,
        artistName: (t.artists ?? []).map((a) => a.name).join(", "),
        albumArt: t.album?.images?.[0]?.url ?? null,
        durationMs: t.duration_ms ?? 0,
      });
    }
    url = data.next;
  }

  // Replace any existing tracks for this session, then bulk insert.
  await prisma.$transaction(async (tx) => {
    await tx.bluegrassSessionTrack.deleteMany({ where: { sessionId: id } });
    if (tracks.length > 0) {
      await tx.bluegrassSessionTrack.createMany({
        data: tracks.map((t, i) => ({
          sessionId: id,
          spotifyUri: t.spotifyUri,
          trackName: t.trackName,
          artistName: t.artistName,
          albumArt: t.albumArt,
          durationMs: t.durationMs,
          sortOrder: i,
        })),
      });
    }
    await tx.bluegrassSession.update({
      where: { id },
      data: { tracksImported: "imported" },
    });
  });

  return NextResponse.json({ ok: true, trackCount: tracks.length }, { status: 201 });
}
