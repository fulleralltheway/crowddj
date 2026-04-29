import { auth } from "@/lib/auth";
import { cachedPlaylistList } from "@/lib/spotify-cache";
import { NextResponse } from "next/server";

const SPOTIFY_API = "https://api.spotify.com/v1";

class SpotifyError extends Error {
  constructor(
    public status: number,
    public retryAfter: number | null,
    public body: { error?: { message?: string; reason?: string } }
  ) {
    super(body?.error?.message || `Spotify ${status}`);
  }
}

/**
 * Bluegrass-specific playlist fetch that surfaces the real Spotify error
 * code + body when the call fails. The shared /api/spotify/playlists
 * collapses every failure into a generic "Failed to fetch playlists"
 * which made the picker un-debuggable from the client.
 *
 * Successful responses are cached per-user for 5 min via spotify-cache so
 * reload-heavy testing doesn't keep poking Spotify with /me/playlists.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tokenError = (session as { tokenError?: string }).tokenError;
  if (tokenError === "RefreshTokenRevoked") {
    return NextResponse.json(
      { error: "TokenRevoked", detail: "Spotify access expired. Sign out and back in." },
      { status: 401 }
    );
  }

  const accessToken = (session as { accessToken?: string }).accessToken;
  if (!accessToken) {
    return NextResponse.json(
      { error: "no_token", detail: "No Spotify access token in session. Sign out and back in." },
      { status: 401 }
    );
  }

  let items: unknown[];
  try {
    items = await cachedPlaylistList<unknown[]>(session.user.id, async () => {
      const res = await fetch(`${SPOTIFY_API}/me/playlists?limit=50`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: { message?: string; reason?: string } }));
        const retryAfterRaw = res.headers.get("retry-after");
        const retryAfter = retryAfterRaw ? parseInt(retryAfterRaw, 10) || null : null;
        throw new SpotifyError(res.status, retryAfter, body);
      }
      const data = await res.json();
      return (data.items ?? []) as unknown[];
    });
  } catch (e) {
    if (!(e instanceof SpotifyError)) {
      return NextResponse.json({ error: "internal_error" }, { status: 500 });
    }
    const spotifyMsg = e.body?.error?.message ?? "";
    const spotifyReason = e.body?.error?.reason ?? "";

    if (e.status === 401) {
      return NextResponse.json(
        {
          error: "spotify_unauthorized",
          status: 401,
          detail: spotifyMsg || "Spotify rejected the access token. Sign out and back in.",
          reason: spotifyReason,
        },
        { status: 401 }
      );
    }

    if (e.status === 403) {
      return NextResponse.json(
        {
          error: "spotify_forbidden",
          status: 403,
          detail: spotifyMsg || "Spotify rejected the request — likely a missing scope. Sign out and back in to re-grant.",
          reason: spotifyReason,
        },
        { status: 403 }
      );
    }

    if (e.status === 429) {
      const retryAfter = Math.max(1, Math.min(600, e.retryAfter ?? 10));
      return NextResponse.json(
        {
          error: "spotify_rate_limited",
          status: 429,
          detail: `Spotify is rate-limiting the app. Retrying in ${retryAfter}s.`,
          retryAfterSec: retryAfter,
        },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      );
    }

    return NextResponse.json(
      {
        error: "spotify_error",
        status: e.status,
        detail: spotifyMsg || `Spotify returned ${e.status}`,
        reason: spotifyReason,
      },
      { status: 502 }
    );
  }

  return NextResponse.json(items);
}
