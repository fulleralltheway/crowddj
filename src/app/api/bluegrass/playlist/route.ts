import { auth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";

const SPOTIFY_API = "https://api.spotify.com/v1";

// Match `https://open.spotify.com/playlist/<id>` (with optional ?si=…) and
// raw URI `spotify:playlist:<id>`. Returns the bare id or null.
function extractPlaylistId(input: string): string | null {
  const trimmed = input.trim();
  const url = trimmed.match(/open\.spotify\.com\/playlist\/([A-Za-z0-9]+)/);
  if (url) return url[1];
  const uri = trimmed.match(/^spotify:playlist:([A-Za-z0-9]+)$/);
  if (uri) return uri[1];
  if (/^[A-Za-z0-9]{16,}$/.test(trimmed)) return trimmed;
  return null;
}

/**
 * Resolve a single playlist by URL/URI/ID. Hits `/v1/playlists/{id}` which is
 * a DIFFERENT rate-limit bucket from `/me/playlists`. While the
 * Development-mode quota on `/me/playlists` is exhausted, this path stays
 * open — that's the workaround we use for the Bluegrass picker.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const accessToken = (session as { accessToken?: string }).accessToken;
  if (!accessToken) {
    return NextResponse.json({ error: "no_token" }, { status: 401 });
  }

  const raw = req.nextUrl.searchParams.get("input") ?? "";
  const playlistId = extractPlaylistId(raw);
  if (!playlistId) {
    return NextResponse.json(
      { error: "invalid_input", detail: "Paste a Spotify playlist URL or URI." },
      { status: 400 }
    );
  }

  const res = await fetch(
    `${SPOTIFY_API}/playlists/${playlistId}?fields=id,uri,name,images,owner.display_name,tracks.total`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!res.ok) {
    const body = await res.json().catch(() => ({} as { error?: { message?: string } }));
    if (res.status === 404) {
      return NextResponse.json(
        { error: "playlist_not_found", detail: "Spotify couldn't find that playlist. Check the link." },
        { status: 404 }
      );
    }
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "30", 10) || 30;
      return NextResponse.json(
        { error: "spotify_rate_limited", retryAfterSec: retryAfter, detail: `Spotify rate-limit. Retry in ${retryAfter}s.` },
        { status: 429 }
      );
    }
    return NextResponse.json(
      {
        error: "spotify_error",
        status: res.status,
        detail: body?.error?.message ?? `Spotify ${res.status}`,
      },
      { status: 502 }
    );
  }

  const data = await res.json();
  return NextResponse.json({
    id: data.id,
    uri: data.uri,
    name: data.name,
    images: data.images ?? [],
    owner: data.owner?.display_name ?? null,
    trackCount: data.tracks?.total ?? null,
  });
}
