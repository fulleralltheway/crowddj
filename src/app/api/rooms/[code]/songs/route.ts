import { prisma } from "@/lib/db";
import { getAudioFeatures, getSpotifyToken } from "@/lib/spotify";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });

  // Return played songs if requested (for "Recently Played" section)
  if (req.nextUrl.searchParams.get("played") === "true") {
    const played = await prisma.roomSong.findMany({
      where: { roomId: room.id, isPlayed: true, trackName: { not: "" } },
      orderBy: { playedAt: "desc" },
      take: 20,
    });
    return NextResponse.json(played);
  }

  const limit = room.queueDisplaySize || 50;

  // Base playlist songs (limited) + all guest-requested songs (always shown)
  // Exclude songs with missing track info (blank entries)
  const hasTrack = { trackName: { not: "" } };
  const [baseSongs, requestedSongs] = await Promise.all([
    prisma.roomSong.findMany({
      where: { roomId: room.id, isPlayed: false, isRequested: false, ...hasTrack },
      orderBy: [{ isPlaying: "desc" }, { sortOrder: "asc" }],
      take: limit,
      include: { votes: { select: { guestId: true, value: true } } },
    }),
    prisma.roomSong.findMany({
      where: { roomId: room.id, isPlayed: false, isRequested: true, ...hasTrack },
      orderBy: [{ isPlaying: "desc" }, { sortOrder: "asc" }],
      include: { votes: { select: { guestId: true, value: true } } },
    }),
  ]);

  // Merge and deduplicate (requested songs may overlap with base if within limit)
  const seenIds = new Set(baseSongs.map((s) => s.id));
  const merged = [...baseSongs, ...requestedSongs.filter((s) => !seenIds.has(s.id))];

  const withScore = merged.map((s) => ({
    ...s,
    netScore: s.upvotes - s.downvotes,
  }));

  // Separate playing, locked, and unlocked
  const playing = withScore.filter((s) => s.isPlaying);
  const nonPlaying = withScore.filter((s) => !s.isPlaying);

  let sorted: typeof withScore;
  const sortMode = room.sortMode || (room.autoShuffle ? "votes" : "manual");
  if (sortMode === "votes") {
    // Pinned songs (DJ position lock) use pinnedPosition as authoritative index.
    // Other locked songs (auto-queue) keep their sortOrder-based positions.
    // Unlocked songs sort by netScore and fill the remaining gaps.
    nonPlaying.sort((a, b) => a.sortOrder - b.sortOrder);
    const pinned = nonPlaying.filter((s) => s.isPinned && s.pinnedPosition != null);
    const lockedNotPinned = nonPlaying.filter((s) => s.isLocked && !s.isPinned);
    const unlocked = nonPlaying.filter((s) => !s.isLocked);
    unlocked.sort((a, b) => {
      if (b.netScore !== a.netScore) return b.netScore - a.netScore;
      return a.sortOrder - b.sortOrder;
    });

    // Build result: pinned songs go at their exact pinnedPosition,
    // locked-not-pinned keep their sortOrder index, unlocked fill gaps
    const totalSlots = nonPlaying.length;
    const result: (typeof withScore[0] | null)[] = new Array(totalSlots).fill(null);

    // 1) Place pinned songs at their explicit positions
    for (const s of pinned) {
      const idx = Math.max(0, Math.min(s.pinnedPosition!, totalSlots - 1));
      if (result[idx] === null) {
        result[idx] = s;
      } else {
        // Slot taken by another pin — find nearest open slot
        for (let d = 1; d < totalSlots; d++) {
          if (idx + d < totalSlots && result[idx + d] === null) { result[idx + d] = s; break; }
          if (idx - d >= 0 && result[idx - d] === null) { result[idx - d] = s; break; }
        }
      }
    }

    // 2) Place locked-not-pinned songs at their sortOrder-based index
    const lockedPositions = new Set<number>();
    lockedNotPinned.forEach((s) => {
      const idx = nonPlaying.indexOf(s);
      if (idx >= 0 && idx < totalSlots && result[idx] === null) {
        result[idx] = s;
        lockedPositions.add(idx);
      }
    });

    // 3) Fill remaining slots with unlocked songs (sorted by netScore)
    let unlockedIdx = 0;
    for (let i = 0; i < totalSlots; i++) {
      if (result[i] === null && unlockedIdx < unlocked.length) {
        result[i] = unlocked[unlockedIdx++];
      }
    }

    sorted = [...playing, ...result.filter((s): s is typeof withScore[0] => s !== null)];
  } else if (sortMode === "playlist") {
    nonPlaying.sort((a, b) => (a.playlistPosition ?? a.sortOrder) - (b.playlistPosition ?? b.sortOrder));
    sorted = [...playing, ...nonPlaying];
  } else {
    nonPlaying.sort((a, b) => a.sortOrder - b.sortOrder);
    sorted = [...playing, ...nonPlaying];
  }

  // "Queued Next" song (lastPreQueuedId) always goes to position 0 in the queue
  if (room.lastPreQueuedId) {
    const queueStart = sorted.findIndex((s) => !s.isPlaying);
    const qIdx = sorted.findIndex((s) => s.id === room.lastPreQueuedId && !s.isPlaying);
    if (qIdx > queueStart && queueStart >= 0) {
      const [queued] = sorted.splice(qIdx, 1);
      sorted.splice(queueStart, 0, queued);
    }
  }

  // Lazy backfill: if any songs missing tempo, fetch audio features and update before returning
  const needsBackfill = sorted.some((s) => s.tempo == null);
  let backfillError: string | null = null;
  if (needsBackfill) {
    const result = await backfillAudioFeatures(room.hostId, sorted.filter((s) => s.tempo == null));
    if (result.error) {
      backfillError = result.error;
    } else if (result.data) {
      for (const song of sorted) {
        const feat = result.data.get(song.id);
        if (feat) Object.assign(song, feat);
      }
    }
  }

  const response = sorted as any[];
  if (backfillError) {
    return NextResponse.json({ songs: response, _backfillError: backfillError });
  }
  return NextResponse.json(response);
}

async function backfillAudioFeatures(hostId: string, songs: { id: string; spotifyUri: string }[]): Promise<{ data?: Map<string, { tempo: number; energy: number; danceability: number }>; error?: string }> {
  try {
    const account = await prisma.account.findFirst({
      where: { userId: hostId, provider: "spotify" },
    });
    if (!account?.refresh_token) return { error: "no_refresh_token" };

    const accessToken = await getSpotifyToken(account.refresh_token);
    const trackIds = songs
      .map((s) => s.spotifyUri.match(/spotify:track:(.+)/)?.[1])
      .filter((id): id is string => !!id);
    if (trackIds.length === 0) return { error: "no_track_ids" };

    const features = await getAudioFeatures(accessToken, trackIds);
    const spotifyMap = new Map<string, { tempo: number; energy: number; danceability: number }>();
    for (const f of features) {
      if (f) spotifyMap.set(f.id, { tempo: f.tempo, energy: f.energy, danceability: f.danceability });
    }

    if (spotifyMap.size === 0) return { error: `no_features_returned_for_${trackIds.length}_tracks` };

    const songFeatures = new Map<string, { tempo: number; energy: number; danceability: number }>();

    await Promise.all(
      songs
        .map((song) => {
          const trackId = song.spotifyUri.match(/spotify:track:(.+)/)?.[1];
          const feat = trackId ? spotifyMap.get(trackId) : null;
          if (!feat) return null;
          songFeatures.set(song.id, feat);
          return prisma.roomSong.update({
            where: { id: song.id },
            data: { tempo: feat.tempo, energy: feat.energy, danceability: feat.danceability },
          });
        })
        .filter(Boolean)
    );

    return { data: songFeatures };
  } catch (e: any) {
    return { error: e?.message || "unknown_error" };
  }
}
