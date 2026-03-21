import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getAudioFeatures } from "@/lib/spotify";
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

  // Lazy backfill BPM for songs missing tempo
  const needsBackfill = sorted.filter((s) => s.tempo == null);
  if (needsBackfill.length > 0) {
    // Tier 1: GetSongBPM (free API, covers most mainstream songs)
    const apiKey = process.env.GETSONGBPM_API_KEY;
    if (apiKey) {
      const updated = await backfillFromGetSongBPM(apiKey, needsBackfill);
      for (const song of sorted) {
        const tempo = updated.get(song.id);
        if (tempo != null) (song as any).tempo = tempo;
      }
    }

    // Tier 2: Spotify Audio Features fallback (catches niche songs)
    const stillMissing = sorted.filter((s) => s.tempo == null);
    if (stillMissing.length > 0) {
      const session = await auth();
      const accessToken = (session as any)?.accessToken;
      if (accessToken) {
        const updated = await backfillFromSpotify(accessToken, stillMissing);
        for (const song of sorted) {
          const data = updated.get(song.id);
          if (data) {
            (song as any).tempo = data.tempo;
            (song as any).energy = data.energy;
            (song as any).danceability = data.danceability;
          }
        }
      }
    }

    // Tier 3: Gemini AI fallback (knows BPM for virtually any song)
    const finalMissing = sorted.filter((s) => s.tempo == null);
    if (finalMissing.length > 0) {
      const geminiKey = process.env.GEMINI_API_KEY;
      if (geminiKey) {
        const updated = await backfillFromGemini(geminiKey, finalMissing);
        for (const song of sorted) {
          const tempo = updated.get(song.id);
          if (tempo != null) (song as any).tempo = tempo;
        }
      }
    }
  }

  return NextResponse.json(sorted);
}

/** Strip parenthetical suffixes like (feat. X), [Remix], (Deluxe), etc. */
function cleanTrackName(name: string): string {
  return name.replace(/\s*[\(\[].*?[\)\]]\s*/g, "").trim();
}

async function backfillFromGetSongBPM(
  apiKey: string,
  songs: { id: string; trackName: string; artistName: string }[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>();

  // Batch: look up up to 10 songs per request cycle to avoid timeout
  const batch = songs.slice(0, 10);

  await Promise.all(
    batch.map(async (song) => {
      try {
        const query = cleanTrackName(song.trackName);
        const res = await fetch(
          `https://api.getsong.co/search/?api_key=${apiKey}&type=song&lookup=${encodeURIComponent(query)}`,
        );
        if (!res.ok) return;
        const data = await res.json();
        const results = Array.isArray(data.search) ? data.search : [];
        // Prefer result matching the artist name
        const artistLower = song.artistName.toLowerCase().split(",")[0].trim();
        const match = results.find((s: any) =>
          s.artist?.name?.toLowerCase().includes(artistLower)
        ) ?? results[0];
        if (match?.tempo) {
          const tempo = parseFloat(match.tempo);
          if (!isNaN(tempo) && tempo > 0) {
            result.set(song.id, tempo);
            await prisma.roomSong.update({
              where: { id: song.id },
              data: { tempo },
            });
          }
        }
      } catch {
        // Skip individual failures
      }
    })
  );

  return result;
}

async function backfillFromSpotify(
  accessToken: string,
  songs: { id: string; spotifyUri: string }[]
): Promise<Map<string, { tempo: number; energy: number; danceability: number }>> {
  const result = new Map<string, { tempo: number; energy: number; danceability: number }>();

  // Extract Spotify track IDs
  const songsByTrackId = new Map<string, string>();
  for (const song of songs.slice(0, 50)) {
    const match = song.spotifyUri.match(/spotify:track:(.+)/);
    if (match) songsByTrackId.set(match[1], song.id);
  }

  if (songsByTrackId.size === 0) return result;

  try {
    const features = await getAudioFeatures(accessToken, [...songsByTrackId.keys()]);
    const updates: Promise<any>[] = [];

    for (const f of features) {
      if (!f || !f.tempo) continue;
      const songId = songsByTrackId.get(f.id);
      if (!songId) continue;

      const data = { tempo: f.tempo, energy: f.energy, danceability: f.danceability };
      result.set(songId, data);
      updates.push(
        prisma.roomSong.update({ where: { id: songId }, data })
      );
    }

    await Promise.all(updates);
  } catch {
    // Spotify API may be deprecated / fail — non-critical
  }

  return result;
}

async function backfillFromGemini(
  apiKey: string,
  songs: { id: string; trackName: string; artistName: string }[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const batch = songs.slice(0, 10);
  if (batch.length === 0) return result;

  const songList = batch.map((s, i) => `${i + 1}. "${cleanTrackName(s.trackName)}" by ${s.artistName.split(",")[0].trim()}`).join("\n");

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `What is the BPM (beats per minute) of each song? Respond ONLY with a JSON array of numbers in the same order. If unknown, use 0.\n\n${songList}` }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 512 },
        }),
      }
    );

    if (!res.ok) return result;
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    // Extract JSON array from response
    const match = text.match(/\[[\d\s,]+\]/);
    if (!match) return result;

    const bpms: number[] = JSON.parse(match[0]);
    const updates: Promise<any>[] = [];

    for (let i = 0; i < Math.min(bpms.length, batch.length); i++) {
      const tempo = bpms[i];
      if (tempo > 0 && tempo < 300) {
        result.set(batch[i].id, tempo);
        updates.push(
          prisma.roomSong.update({ where: { id: batch[i].id }, data: { tempo } })
        );
      }
    }

    await Promise.all(updates);
  } catch {
    // Gemini fallback is non-critical
  }

  return result;
}
