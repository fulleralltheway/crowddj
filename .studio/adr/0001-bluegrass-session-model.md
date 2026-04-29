---
number: 0001
slug: bluegrass-session-model
status: accepted
date: 2026-04-28
supersedes: none
---

# ADR 0001: Use a separate `BluegrassSession` model instead of overloading `Room`

## Context

PartyQueue's `Room` model is a kitchen sink: it owns a Spotify playlist, a queue of `RoomSong` rows, vote counters, guest tracking, fingerprint-based abuse controls, blocked-artist lists, push subscriptions, settings spanning ~25 columns, and a relationship-rich graph (`songs`, `guests`, `songRequests`). Every API route under `/api/rooms/[code]/*` and every transition path (`sync-rooms`, `fade-transition`, `fade-skip`, `lock-next`, `reorder`) reads `RoomSong` rows and reasons about queue order, pinned positions, locks, and pre-queue state.

The Bluegrass DJ feature (see `specs/bluegrass-dj/spec.md`) needs none of that:

- Single authenticated user; no guests, no fingerprinting, no votes.
- No `RoomSong` rows. The "queue" is Spotify's own playlist context — we play `spotify:playlist:XXX` and let Spotify's native ordering handle track-to-track advancement.
- The only state we track is "what playlist, what device, what threshold settings, what's currently playing, and is the session active."

But Bluegrass DJ does need PartyQueue's transition machinery: `buildFadeCurve`, `restoreVolume`, the socket server's `setInterval` + `setTimeout` precise scheduling, the deferred-fade-via-cron pattern, and the persistent NextAuth + Spotify token refresh.

We have to pick a data shape. Three options:

1. Add a `mode: "party" | "dj"` field to `Room` and reuse the model.
2. Reuse `Room` implicitly by treating "DJ rooms" as rooms with zero `RoomSong` rows.
3. Create a new, focused `BluegrassSession` model that lives alongside `Room`.

## Decision

We will create a new `BluegrassSession` model. The two pipelines (`Room` for crowd-sourced DJ, `BluegrassSession` for solo DJ) live side-by-side. They share `User` + `Account` (auth + Spotify tokens) and reuse pure utilities (`buildFadeCurve`, the `restoreVolume` retry pattern), but have parallel API routes, parallel cron endpoints (`sync-bluegrass`, `bluegrass-fade-transition`), and parallel sync loops in `socket-server.ts` (`backgroundSessions` next to `backgroundRooms`).

## Consequences

### Positive

- `Room`'s schema and code paths stay untouched. Zero risk of regressing PartyQueue's existing behavior — and PartyQueue is in active production use, so any regression hurts real parties.
- `sync-rooms` and `fade-transition` keep their queue-aware logic unencumbered by `if (mode === 'dj')` branches. Reading those files in 6 months remains tractable.
- Schema for Bluegrass is tiny — ~12 columns vs. Room's ~25 — and every column has a clear single purpose. New developers (or future-Claude) can understand the model in one read.
- Future Bluegrass-only features (different fade curves, multi-zone playback, simpler analytics) don't need to defend against accidentally affecting Room behavior.
- The `socket-server.ts` extension is purely additive (new Map, new setInterval, new event names) — small, reversible, easy to review in Phase 5.

### Negative

- Two models to keep in sync if we ever want a feature that should apply to both (e.g., a new fade curve algorithm, a new device-selection helper). Mitigated by: shared utilities live in `src/lib/`, not in model-specific code; the cost of re-applying a change to two parallel `*-fade-transition` routes is small (they're ~80 lines each).
- Slightly more code than the `mode` field option (estimated +200 LOC). Worth the cost for the isolation guarantee.
- Two parallel cron endpoints and two parallel sync loops mean the socket server's per-tick work doubles. Negligible at current usage (max one or two active sessions in addition to a handful of rooms).

### Neutral

- The two pipelines could be consolidated later (e.g., when a third "mode" emerges) by extracting a common interface. The pipelines being parallel makes that refactor easier to reason about than retrofitting a `mode` discriminator into the existing graph.

## Alternatives Considered

### Alternative 1: Add `mode: "party" | "dj"` field to `Room`

Add a discriminator column to `Room` and branch every queue-aware code path. Reduces total LOC.

Rejected because:
- Every code path that touches `Room.songs`, `getNextSong`, `reorderByVotes`, `shiftPinnedPositions`, `lock`, `lock-next` would need a `if (room.mode === 'dj') return early` early-exit. ~12+ branch points across `src/lib/queue.ts`, `src/lib/reorder.ts`, and the API routes. Each is a place a future bug could leak DJ-mode assumptions into Party-mode handling or vice versa.
- The `Room` schema would carry columns that mean different things in different modes, or that are nullable in one mode and required in the other. That's a known antipattern.
- The crowd-sourced DJ pipeline is the more complex one — adding mode-awareness to it is strictly extra cognitive load with no payoff for Party users.

### Alternative 2: Reuse `Room` implicitly (DJ rooms have zero `RoomSong` rows)

No schema change. A "DJ room" is just a `Room` whose `songs` collection is always empty.

Rejected because:
- `sync-rooms` would need to detect "this is a DJ-mode room" implicitly from the empty `songs` set, which is fragile (what if a song row is left over from a previous run?). Implicit modes always become explicit eventually, and pretending otherwise produces bugs.
- The DJ pipeline still needs columns Room doesn't have (`currentTrackUri`, `trackStartedAt`, `stopAfterCurrent`) or has under different semantics (`playlistId` is a string ID for `getPlaylistTracks`; for DJ mode we need the full `spotify:playlist:XXX` URI for `startPlayback`).

### Status quo (do nothing)

Don't ship Bluegrass DJ. Abigail keeps doing whatever she does today.

Rejected because the request is explicit, in-scope, and the user has committed budget to Vercel Pro to support the necessary cron infrastructure.

## References

- Spec: `../specs/bluegrass-dj/spec.md`
- Plan: `~/.claude/plans/radiant-sauteeing-matsumoto.md`
- Reference patterns: `socket-server.ts` (`backgroundRooms`, `triggerServerFade`, `scheduledFades`), `src/app/api/cron/fade-transition/route.ts` (`restoreVolume` retry helper), `src/lib/fade-curve.ts` (`buildFadeCurve`)
