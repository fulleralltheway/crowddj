import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

const SPOTIFY_API = "https://api.spotify.com/v1";

/**
 * Bluegrass-specific playlist fetch that surfaces the real Spotify error
 * code + body when the call fails. The shared /api/spotify/playlists
 * collapses every failure into a generic "Failed to fetch playlists"
 * which made the picker un-debuggable from the client.
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

  const res = await fetch(`${SPOTIFY_API}/me/playlists?limit=50`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({} as { error?: { message?: string; reason?: string } }));
    const spotifyMsg = body?.error?.message ?? "";
    const spotifyReason = body?.error?.reason ?? "";

    // 401 = token expired or invalid → user needs to re-auth
    if (res.status === 401) {
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

    // 403 = scope missing or premium required
    if (res.status === 403) {
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

    // 429 = rate limit. Spotify includes a Retry-After header (in seconds)
    // telling us how long to wait. Surface it to the client so it can
    // show a countdown and auto-retry instead of flat-failing.
    if (res.status === 429) {
      const retryAfterRaw = res.headers.get("retry-after") ?? "10";
      const retryAfter = Math.max(1, Math.min(600, parseInt(retryAfterRaw, 10) || 10));
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

    // Everything else (5xx outage, etc.)
    return NextResponse.json(
      {
        error: "spotify_error",
        status: res.status,
        detail: spotifyMsg || `Spotify returned ${res.status}`,
        reason: spotifyReason,
      },
      { status: 502 }
    );
  }

  const data = await res.json();
  return NextResponse.json(data.items ?? []);
}
