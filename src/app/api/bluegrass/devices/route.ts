import { auth } from "@/lib/auth";
import { getDevices } from "@/lib/spotify";
import { cachedDevices } from "@/lib/spotify-cache";
import { NextResponse } from "next/server";

/**
 * Sessionless device list. Used by the playlist picker BEFORE a session
 * exists (the user has to pick a device to create a session in the first
 * place). Auth-gated like every bluegrass endpoint; access token comes
 * from the user's Spotify account, not from a session row.
 *
 * Cached per-user for 30s (devices come and go, but reload-heavy testing
 * shouldn't repeatedly hit Spotify in the same window).
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const accessToken = (session as { accessToken?: string }).accessToken;
  if (!accessToken) {
    return NextResponse.json({ error: "no_token" }, { status: 401 });
  }

  const devices = await cachedDevices(session.user.id, () => getDevices(accessToken));
  return NextResponse.json(
    devices.map((d: { id: string; name: string; type: string; is_active: boolean; volume_percent: number | null }) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      isActive: d.is_active,
      volumePercent: d.volume_percent,
    }))
  );
}
