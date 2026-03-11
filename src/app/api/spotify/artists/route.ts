import { auth } from "@/lib/auth";
import { searchArtists } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const accessToken = (session as any).accessToken;
  if (!accessToken) return NextResponse.json({ error: "No Spotify token" }, { status: 401 });

  const q = req.nextUrl.searchParams.get("q");
  if (!q) return NextResponse.json({ error: "Missing query" }, { status: 400 });

  try {
    const artists = await searchArtists(accessToken, q);
    return NextResponse.json(artists);
  } catch {
    return NextResponse.json({ error: "Failed to search" }, { status: 500 });
  }
}
