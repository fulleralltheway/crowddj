import { auth } from "@/lib/auth";
import { getUserPlaylists } from "@/lib/spotify";
import { NextResponse } from "next/server";

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const accessToken = (session as any).accessToken;
  if (!accessToken) return NextResponse.json({ error: "No Spotify token" }, { status: 401 });

  try {
    const playlists = await getUserPlaylists(accessToken);
    return NextResponse.json(playlists);
  } catch {
    return NextResponse.json({ error: "Failed to fetch playlists" }, { status: 500 });
  }
}
