import { auth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";

const SPOTIFY_API = "https://api.spotify.com/v1";

type SearchTrack = {
  uri: string;
  name: string;
  artists?: { name: string }[];
  album?: { images?: { url: string }[] };
  duration_ms: number;
};

/**
 * Wrap Spotify /v1/search?type=track. Returns a trimmed shape ready for the
 * queue-insert flow. The /v1/search endpoint is in a different rate-limit
 * bucket from the playlist-metadata endpoints — confirmed via probe in the
 * earlier rate-limit debug session.
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

  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 2) {
    return NextResponse.json({ error: "query_too_short", detail: "Type at least 2 characters." }, { status: 400 });
  }
  const limitRaw = parseInt(req.nextUrl.searchParams.get("limit") ?? "10", 10);
  const limit = Math.max(1, Math.min(20, Number.isFinite(limitRaw) ? limitRaw : 10));

  const url = `${SPOTIFY_API}/search?type=track&limit=${limit}&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({} as { error?: { message?: string } }));
    if (res.status === 429) {
      const retryAfterRaw = res.headers.get("retry-after");
      const retryAfter = retryAfterRaw ? Math.max(1, Math.min(3600, parseInt(retryAfterRaw, 10) || 30)) : 30;
      return NextResponse.json(
        {
          error: "spotify_rate_limited",
          status: 429,
          retryAfterSec: retryAfter,
          detail: `Spotify rate-limited search. Retry in ${retryAfter}s.`,
        },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
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

  const data = (await res.json()) as { tracks?: { items?: SearchTrack[] } };
  const items = (data.tracks?.items ?? []).map((t) => ({
    uri: t.uri,
    name: t.name,
    artist: (t.artists ?? []).map((a) => a.name).join(", "),
    image: t.album?.images?.[0]?.url ?? null,
    durationMs: t.duration_ms,
  }));
  return NextResponse.json({ results: items });
}
