# Bluegrass Queue Management — Tasks

> Implementation breakdown for Phase 3 (Build). Every task has a verification criterion. Mark `[doing]` when started, `[done]` when its verification passes.

## Worktree

- [ ] **T0 — Create worktree on `feature/bluegrass-queue`**
  - Action: `git worktree add ../bluegrass-queue -b feature/bluegrass-queue` from `~/spotifyapp`. All subsequent tasks happen in `../bluegrass-queue`.
  - Verification: `git -C ../bluegrass-queue branch --show-current` prints `feature/bluegrass-queue`.

## Schema

- [ ] **T1 — Add `BluegrassSessionTrack` model + `tracksImported` enum**
  - Action: Add `BluegrassSessionTrack` per ADR 0002. Add `enum TrackImportStatus { pending importing imported failed }` and `tracksImported TrackImportStatus @default(pending)` to `BluegrassSession`. Add the relation `tracks BluegrassSessionTrack[]` to `BluegrassSession`. Run `prisma generate`. Pull production env, run `prisma db push`, then `rm .env.production.local`.
  - Verification: `npx prisma generate` clean; `bluegrassSessionTrack` typed import works; `prisma db push` reports "Database is now in sync"; the empty table has the `(sessionId, isPlayed, sortOrder)` index.

## Library

- [ ] **T2 — `src/lib/bluegrass-queue.ts` — `getNextSessionTrack` + helpers**
  - Action: New file with `getNextSessionTrack(sessionId)` returning the first row matching `{ sessionId, isPlayed: false }` ordered by `sortOrder asc`. Plus `markCurrentPlayed(sessionId, currentUri)` and `assignSortOrders(sessionId, ids)` helpers used by reorder/insert.
  - Verification: New file `bluegrass-queue.test.ts` covers (a) returns null on empty queue, (b) returns first unplayed by sortOrder, (c) `markCurrentPlayed` flips isPlayed when URI matches, (d) `assignSortOrders` writes contiguous ints. `npm run test` green.

## API — queue CRUD

- [ ] **T3 — `POST /api/bluegrass/sessions/[id]/queue/import`**
  - Action: Auth-gated, ownership-checked. Sets `tracksImported: importing`. Calls `getPlaylistTracks(token, playlistId)` (paginated). Bulk-creates `BluegrassSessionTrack` rows with `sortOrder = 0..N-1, isPlayed: false`. Sets `tracksImported: imported` on success. On Spotify 429 → sets `tracksImported: failed`, returns 429 with retryAfterSec. Idempotent: running twice deletes existing rows then re-imports.
  - Verification: With a real playlist, returns 201 + `{ trackCount: N }`. Querying `BluegrassSessionTrack` shows N rows in order. Re-running replaces them. With `/v1/playlists/{id}/tracks` rate-limited (mock or real), returns 429 with `retryAfterSec` and session's `tracksImported` is `failed`.

- [ ] **T4 — `GET /api/bluegrass/sessions/[id]/queue`**
  - Action: Returns `{ tracksImported, currentTrackUri, queue: [...] }` where `queue` is all rows sorted by `sortOrder` (played + unplayed flagged, but client typically only renders unplayed + the playing one). Trimmed shape: `{ id, spotifyUri, trackName, artistName, albumArt, durationMs, sortOrder, isPlaying, isPlayed, addedManually }`.
  - Verification: Curl with auth → JSON matches shape. Sorted ascending. Unauthenticated → 401. Unowned session → 404.

- [ ] **T5 — `POST /api/bluegrass/sessions/[id]/queue/insert`**
  - Action: Body `{ uri, name, artist, image, durationMs, position: "next" | "end" }`. Validates URI is `spotify:track:*`. For "next": `sortOrder = (currentSortOrder ?? -1) + 0.5` then renumber-contiguous in a transaction. For "end": `sortOrder = max(sortOrder) + 1`. Sets `addedManually: true`. Returns the new row.
  - Verification: With a session playing track at sortOrder=2, inserting "next" lands the new row at sortOrder=3 (queue becomes 0,1,2,**3**,4,5,…). Insert "end" lands at the bottom. Duplicate URI rejected with 409 (avoid same track twice in queue).

- [ ] **T6 — `DELETE /api/bluegrass/sessions/[id]/queue/[trackId]`**
  - Action: Validate the track belongs to the session AND has `isPlayed: false` AND is not currently playing. Hard-delete the row. Renumber-contiguous the remaining unplayed rows.
  - Verification: Removing a queued unplayed track returns 200 + `{ removed: true }`. Subsequent `GET queue` shows it gone, gaps closed. Removing the currently-playing row returns 409. Removing a played row returns 404 (not queue-visible).

## API — search

- [ ] **T7 — `GET /api/bluegrass/search?q=<query>&limit=10`**
  - Action: Auth-gated. Wraps `/v1/search?type=track&limit=10`. Returns trimmed track shape `{ uri, name, artist, image, durationMs }`. Surface 429 with `retryAfterSec` per the SpotifyError class pattern from `/api/bluegrass/playlists`. q must be ≥2 chars; <2 returns 400.
  - Verification: Searching "abba" returns ≥5 trimmed track objects. q="" → 400. Spotify 429 → 429 + retryAfterSec. No tokens leak in response.

## Refactor — playback paths use the DB queue

- [ ] **T8 — `fade-skip` uses `getNextSessionTrack` instead of `getPlaylistTracks`**
  - Action: Replace the `getPlaylistTracks → findIndex → nextTrackUri` block with `getNextSessionTrack(sessionId)`. After a successful transition, call `markCurrentPlayed` for the previous track and update the next track to `isPlaying: true, currentTrackUri: nextUri` on the session. Drop the `getPlaylistTracks` import. Keep the relinking-aware fallback to `skipToNext` (Spotify's native) when DB queue is empty (tracks not imported, or all played).
  - Verification: Spotify call log for one fade-skip shows zero requests to `/v1/playlists/*`. Smoke: with a 5-track imported queue, three consecutive skips advance through tracks 1→2→3→4 in order.

- [ ] **T9 — `bluegrass-fade-transition` uses `getNextSessionTrack`**
  - Action: Same swap as T8 in the cron-driven path. `stopAfterCurrent` branch unchanged (still pauses).
  - Verification: With `maxSongDurationSec = 15`, three consecutive auto-fades advance 1→2→3. Vercel logs show zero `/v1/playlists/*` calls during playback.

## UI — Queue panel

- [ ] **T10 — Queue sheet in `BluegrassClient`**
  - Action: New "Queue" button in the now-playing layout (alongside Settings + Change Playlist). Tapping opens a `<Sheet>` with the queue list. Currently-playing track sticky at top, scrollable list of upcoming below. Each row shows art, track, artist; tap a small `×` to remove. Played tracks not shown. Dimmed "Loading queue…" while `tracksImported === importing`. Error state with Retry button when `tracksImported === failed` (calls `/queue/import` again).
  - Verification: Spec V1, V3, V11. Manual: open the panel mid-class, queue is correct; closing/reopening preserves it.

- [ ] **T11 — Search + insert inside the queue sheet**
  - Action: Inline search input above the queue list. Debounce 300ms. Hits `/api/bluegrass/search`. Each result row has art + track + artist, plus two buttons: `Play next` and `Add to end`. Tapping calls `/queue/insert` with the right `position`. Optimistic UI: the row appears in the queue list immediately, server confirms or reverts on error.
  - Verification: Spec V2, V3, V5, V6. Manual: search "song", tap Play next, see it appear in the queue list at position 2.

## Tests + cleanup

- [ ] **T12 — Wire import into session-start UX**
  - Action: After `startWithPlaylist` creates the session, fire `POST /queue/import` once. Show "Loading queue…" until `tracksImported === imported`. On `failed` (rate limit), show the wait message + manual retry button (reuses the same back-off as the existing `loadPlaylists` localStorage marker).
  - Verification: After paste-URL session start, queue panel populates within ~2 seconds (small playlist) or shows the rate-limit message with retry. No infinite spinner.

- [ ] **T13 — Phase-4 verify gates**
  - Action: `npm run build` clean (zero warnings). `npm run test` green (existing 21 + new bluegrass-queue tests). ESLint clean across all changed files.
  - Verification: All three commands produce zero errors / warnings.

## Phase-3 exit criteria

When **all of T0–T13 are done** and the build is clean, advance state.md to Phase 4 and run the cold-context Phase 5 reviewer per `~/Hub/development/skills/ship-feature.md`.
