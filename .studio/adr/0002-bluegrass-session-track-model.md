---
number: 0002
slug: bluegrass-session-track-model
status: accepted
date: 2026-04-29
supersedes: none
---

# ADR 0002: `BluegrassSessionTrack` as a separate model from `RoomSong`

## Context

The Bluegrass queue management feature (see `specs/bluegrass-queue/spec.md`) needs persistent tracks scoped to a session. PartyQueue's `RoomSong` model already represents tracks-in-a-room; superficially we could reuse it. We chose not to, for the same reasons as ADR 0001's `BluegrassSession` decision: keep the two pipelines parallel and uncoupled.

`RoomSong` carries fields that don't apply to Bluegrass (`upvotes`, `downvotes`, `isLocked`, `isRequested`, `isPinned`, `pinnedPosition`, `previewUrl`, `tempo`, `energy`, `danceability`, `addedBy`, `addedByName`, `votes Vote[]`) and is wired into queue-aware logic (`reorderByVotes`, `getNextSong` with locked-songs / pinned positions / pre-queue). Reusing it would either:

1. Pollute Bluegrass with party-mode fields it never sets, surface noise on every read.
2. Force conditional code paths (`if mode === 'dj'`) into the existing PartyQueue helpers, recreating the exact branching mess ADR 0001 was written to avoid.

`BluegrassSessionTrack` is the right shape for the actual need: a flat ordered list of tracks with `isPlayed` + `sortOrder`, plus an `addedManually` flag for tracks Abigail inserts mid-session.

## Decision

Add a new Prisma model `BluegrassSessionTrack` with a 1:N relation from `BluegrassSession`. Trim it to the fields the feature actually uses:

```
model BluegrassSessionTrack {
  id             String           @id @default(cuid())
  sessionId      String
  session        BluegrassSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  spotifyUri     String
  trackName      String
  artistName     String
  albumArt       String?
  durationMs     Int
  sortOrder      Int
  isPlaying      Boolean          @default(false)
  isPlayed       Boolean          @default(false)
  addedManually  Boolean          @default(false)
  addedAt        DateTime         @default(now())

  @@index([sessionId, isPlayed, sortOrder])
}
```

Plus an enum on `BluegrassSession` for import status (`tracksImported: TrackImportStatus`) so the UI can distinguish "haven't imported yet" from "imported and queue is empty because everything played."

A new helper `getNextSessionTrack(sessionId)` lives in `src/lib/bluegrass-queue.ts` (parallel to `src/lib/queue.ts`'s `getNextSong`). The `fade-skip` and `bluegrass-fade-transition` routes call it instead of `getPlaylistTracks`.

## Consequences

### Positive

- `RoomSong` and the PartyQueue queue helpers stay untouched — zero regression risk to crowd-sourced parties.
- Bluegrass code paths read 11 columns vs. ~22 for `RoomSong`. Queries are smaller, smaller payloads to client, less mental overhead.
- `getNextSessionTrack` is dead simple — one Prisma `findFirst` ordered by `sortOrder` on the indexed `(sessionId, isPlayed, sortOrder)` tuple. No vote-aware merge, no pinned-position handling, no pre-queue lock dance. Bug surface is small.
- The architectural cleanup from this feature (DB-backed queue, no per-skip Spotify metadata fetch) is independent of PartyQueue's transition system. PartyQueue can keep its existing logic; Bluegrass gets the cleaner version.
- Schema migration is purely additive — new model + new column on `BluegrassSession`. Zero impact on existing rows.

### Negative

- Two queue models (`RoomSong` + `BluegrassSessionTrack`) and two next-track helpers (`getNextSong` + `getNextSessionTrack`) to maintain. Mitigation: pure utilities (`buildFadeCurve`, the `restoreVolume` retry pattern) stay shared; only the queue-shape-specific code is duplicated. Synchronizing two simple functions has been cheap so far for the bluegrass-dj feature; we expect the same here.
- A few additional ~80 LOC vs. the `mode`-field option. Worth it for the isolation guarantee — same trade-off ADR 0001 made.
- Future "shared search history" or "shared track-art cache" features would have to query both tables. Acceptable; we'll cross that bridge if it appears.

### Neutral

- Future consolidation (e.g., when a third "mode" emerges) is straightforward: extract a common `Track` interface, both models implement it. The parallel structure makes that refactor easier to reason about than retrofitting a discriminator into a kitchen-sink schema.

## Alternatives Considered

### Alternative 1: Reuse `RoomSong` with a new `bluegrassSessionId` foreign key

Add `bluegrassSessionId String?` to `RoomSong` alongside `roomId String`. One row could belong to either a `Room` or a `BluegrassSession`.

Rejected because:
- The existing `roomId` field is `String` (non-null) at the Prisma level — making it nullable touches a load-bearing relation.
- Every query against `RoomSong` would need to filter on `roomId IS NOT NULL` or `bluegrassSessionId IS NOT NULL` to avoid mixing modes. Easy to forget, hard to detect.
- All the unused Party-mode columns (`upvotes`, `votes Vote[]`, `isPinned`, etc.) still get carried per Bluegrass row.
- The `Vote[]` relation on `RoomSong` would point at rows for sessions that never have votes — odd graph shape.

### Alternative 2: Reuse `RoomSong` and create a synthetic `Room` per Bluegrass session

Treat each Bluegrass session as a one-host, zero-guest `Room` and use `RoomSong` as-is.

Rejected because:
- We already have `BluegrassSession` (per ADR 0001). Now we'd have BOTH a `BluegrassSession` and a synthetic `Room` per session — every Bluegrass user creates two parallel records that have to stay in sync.
- All the cron paths (`sync-rooms`, `fade-transition`) would fire against these synthetic rooms with conditional logic to bypass voting/locking. Same branching mess that ADR 0001 rejected.

### Alternative 3: Store the queue as a JSON array on `BluegrassSession`

Add `queue Json` to `BluegrassSession`, serialize the track list as JSON.

Rejected because:
- No indexing on `isPlayed` / `sortOrder`. Every `getNextSessionTrack` call deserializes the entire JSON, which scales poorly for 100+ track playlists.
- Inserts are O(N) in JSON-rewrite, not O(1) row-insert.
- Concurrent updates (cron + user action) race on the whole JSON blob, requiring optimistic concurrency control we don't have today.
- Schema introspection / Prisma Studio / debugging — all worse than a real table.

### Status quo (do nothing)

Keep the per-skip `/v1/playlists/{id}/tracks` fetch.

Rejected because:
- Already proven brittle — the recent rate-limit episode put the picker AND the skip path in extended cool-down with no in-app remediation. A persistent queue is the principled fix.
- No path to in-app search + insert without a queue, so this also blocks the user-requested feature.

## References

- Spec: `../specs/bluegrass-queue/spec.md`
- Prior ADR: `0001-bluegrass-session-model.md` (parallel-pipeline pattern)
- Reference patterns: `src/lib/queue.ts` (`getNextSong`), `src/app/api/rooms/[code]/skip` family
- Recent debug session: paste-URL workaround in `f5ded0f` / `17b368e` (Spotify Dev-mode rate limit on playlist endpoints)
