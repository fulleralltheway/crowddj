---
name: Bluegrass Queue Management
slug: bluegrass-queue
status: shipped
created: 2026-04-29
signed_off: 2026-04-29
shipped: 2026-04-29
---

# Bluegrass Queue Management

> Give Abigail an in-app view of what's coming up in the playlist she loaded, plus the ability to search a Spotify track and insert it into the queue from her phone — without running to her laptop. Doubles as the architectural fix that eliminates per-skip `/v1/playlists/{id}/tracks` lookups (the source of recent rate-limit pain).

## 1. Outcomes

- [ ] **O1:** While a session is playing, opening a "Queue" panel in the PWA shows a scrollable list of upcoming tracks with album art, track name, artist, and the currently-playing track highlighted.
- [ ] **O2:** Tapping a search icon, typing 2+ characters, and waiting ≤500ms shows up to 10 Spotify search results with album art, name, and artist.
- [ ] **O3:** Tapping a search result shows two insertion options — "Play next" and "Add to end" — and tapping one inserts the track into the queue at the chosen position. The queue panel reflects the change within 500ms.
- [ ] **O4:** Tapping Skip on the now-playing controls advances to the **next track in the queue as displayed in the panel** — including any tracks Abigail manually inserted. No `/v1/playlists/{id}/tracks` call happens at skip time.
- [ ] **O5:** When the session-level threshold (`maxSongDurationSec`) fires an auto-fade, the next track played is the next track in the queue as displayed — same as a manual skip.
- [ ] **O6:** The queue persists for the session: closing and reopening the PWA shows the same queue, with the currently-playing track and any inserted tracks preserved.
- [ ] **O7:** The user-facing flow does NOT depend on the `/me/playlists` or `/v1/playlists/{id}` endpoints during a running session. After session start, the only Spotify endpoints touched are `/me/player/*` (already proven not rate-limited in our Dev quota) and `/v1/search` (different endpoint family).
- [ ] **O8:** Removing a queued track that hasn't played yet works from the queue panel (swipe-or-tap to delete) and the queue updates within 500ms.

## 2. Scope Boundaries

### In Scope

- New Prisma model `BluegrassSessionTrack` (one row per track in the queue, scoped to a session).
- One-time **import** of Spotify playlist tracks into `BluegrassSessionTrack` rows when a session is created or when the user changes playlist mid-session. Hits `/v1/playlists/{id}/tracks` (paginated). If currently rate-limited, surfaces "playlist import unavailable, try again in N minutes" — the user can retry without losing their session.
- New API endpoints under `/api/bluegrass/sessions/[id]/queue`: list, insert, remove, reorder.
- New `/api/bluegrass/search` endpoint wrapping Spotify's `/v1/search?type=track`.
- Refactor of `fade-skip` and `bluegrass-fade-transition` to look up next track via DB (`getNextSessionTrack(sessionId)`), not via `/v1/playlists/{id}/tracks`.
- New "Queue" UI panel in `BluegrassClient` — scrollable list, search input, insertion picker, currently-playing highlight.
- Track-import status field on `BluegrassSession` (`tracksImported: boolean | enum`) so the UI knows whether the queue is populated yet.

### Explicitly Out of Scope

- Drag-to-reorder in the UI. Keep insertion to "Play next" / "Add to end" for v1; if Abigail asks for finer control later, we add it.
- Voting, votes, vote-based reordering. Bluegrass is single-user; she has full authority.
- Auto-import of new tracks when she edits the playlist on Spotify. v1 imports once per session-start or playlist-change.
- Search across podcasts/episodes. Track type only.
- Sharing the queue with other users / multi-user editing.
- Showing already-played tracks in the queue panel. Played tracks are dropped from the visible list (still in DB for audit).
- Local-file playlist support — Spotify Web API can't play local files anyway.
- A fallback for when `/v1/playlists/{id}/tracks` is rate-limited at session-start. We surface the error and let the user retry. (Long-term fix: Extended Quota mode — tracked separately.)

## 3. Constraints

- **Technical:**
  - Reuse the existing `BluegrassSession` model — add a relation `tracks BluegrassSessionTrack[]` and an enum/flag for import status. New model `BluegrassSessionTrack` mirrors PartyQueue's `RoomSong` shape but trimmed (no votes, locks, pinned positions, tempo features).
  - DB query for "next track" must be O(1) on the indexed `(sessionId, isPlayed, sortOrder)` tuple. Pattern: `findFirst where { sessionId, isPlayed: false } order by sortOrder asc`.
  - `/v1/search` rate-limit behavior is unknown but presumed independent of `/me/playlists`. Endpoint instrumented with the same SpotifyError-class error surface as `/api/bluegrass/playlists` so 429s are visible.
  - All new endpoints `auth()`-gated and ownership-checked against `sess.userId`.
  - Vercel Pro `maxDuration = 60` on any endpoint that mutates Spotify state.
  - Build warnings = errors per `~/Hub/.claude/rules/development.md`.
- **Time:** No hard deadline. Ship when Phase 5 review says "ship" and Phase 6 QA passes against a real test session.
- **Compliance / security:**
  - No Spotify tokens leak to the client.
  - Queue-mutation endpoints reject 401 unauthenticated, 404 unowned-session, 409 inactive-session, 400 invalid input ranges.
  - Phase 5 includes `/security-review` (touches auth + external API).
- **Design / UX:**
  - Phone-first, single-screen. Queue panel slides up from the bottom on tap (similar to existing settings/playlist sheets). Touch targets ≥56pt on insert + remove buttons.
  - Currently-playing track always visible at the top of the queue panel even when scrolled.
  - Search results render with debounced fetch (≥250ms after last keystroke) so we don't hammer `/v1/search` while typing.
  - Optimistic UI on insert/remove: panel updates instantly, server response confirms or reverts.

## 4. Prior Decisions This Builds On

- ADR 0001 (`bluegrass-session-model`): `BluegrassSession` is its own model parallel to `Room`, NOT a `mode` field. Adding `BluegrassSessionTrack` continues that pattern — distinct from `RoomSong`.
- The `/me/player/*` endpoint family is currently NOT rate-limited (verified via direct probe in the recent debug session). Built on that observation: the queue's playback path uses these endpoints, the queue's metadata path uses `/v1/search` and (one-time) `/v1/playlists/{id}/tracks`.
- PartyQueue's `getNextSong()` in `src/lib/queue.ts` is the reference pattern for next-track resolution. We'll write a Bluegrass-specific `getNextSessionTrack()` rather than extending the existing function — same separation rationale as ADR 0001.
- The client-side paste-URL picker (shipped in `f5ded0f` / `17b368e`) remains the entry point for picking a playlist. After paste, the first action in the new session is **import** the playlist's tracks into `BluegrassSessionTrack` rows.

## 5. High-Level Tasks

1. **Schema:** add `BluegrassSessionTrack` model + `tracksImported` enum on `BluegrassSession`. `prisma db push` against Neon prod.
2. **Import endpoint:** `POST /api/bluegrass/sessions/[id]/queue/import` — fetches `/v1/playlists/{id}/tracks` (paginated), populates `BluegrassSessionTrack` rows with `sortOrder = 0..N-1`, sets `tracksImported`. Idempotent on re-call (truncates and re-imports).
3. **Queue list / insert / remove endpoints:** `GET /api/bluegrass/sessions/[id]/queue`, `POST /api/bluegrass/sessions/[id]/queue/insert` (body: `{ uri, name, artist, image, durationMs, position: "next" | "end" }`), `DELETE /api/bluegrass/sessions/[id]/queue/[trackId]`.
4. **Search endpoint:** `GET /api/bluegrass/search?q=...` wrapping Spotify `/v1/search?type=track&limit=10`. Returns trimmed track objects.
5. **Refactor fade endpoints:** `fade-skip` and `bluegrass-fade-transition` look up next track via the DB. Drop the `/v1/playlists/{id}/tracks` call from these paths entirely. Update the existing tests to match.
6. **UI: Queue panel** in `BluegrassClient` — `<details>` or sheet with scrollable list, currently-playing highlight, swipe-to-remove (or tap-to-remove for v1 simplicity).
7. **UI: Search & insert:** search input inside the queue panel, debounced fetch, results list, "Play next" / "Add to end" buttons per result.
8. **Wire import into session-start:** after `startWithPlaylist` creates the session, fire the import endpoint. Show "Loading queue…" until import completes; surface 429 with a retry button.

## 6. Verification Criteria

- [ ] **V1 (build):** `cd ~/spotifyapp && npm run build` clean, **zero warnings**.
- [ ] **V2 (schema):** `BluegrassSessionTrack` table exists in production Neon DB with index `(sessionId, isPlayed, sortOrder)`. Confirmed via `prisma studio` or Neon console.
- [ ] **V3 (import):** Pasting a Spotify playlist URL with 30 tracks, then opening the queue panel, shows 30 rows in the playlist's original order. Album art + track name + artist visible on each row.
- [ ] **V4 (next-track):** With `maxSongDurationSec = 15` and a 30-track playlist, after the auto-fade fires for track 1, track 2 plays. After the next auto-fade, track 3 plays. Confirmed via the `currentTrackUri` in `/state` matching the queue panel's "now playing."
- [ ] **V5 (insert):** While playing, search "song name", tap a result, tap "Play next" — the queue panel shows that track at position 2 (right after current). When current threshold fires, that inserted track plays next.
- [ ] **V6 (insert at end):** Same as V5 but tapping "Add to end" puts the track at the bottom of the queue. After all original tracks play through, the inserted track plays.
- [ ] **V7 (remove):** Tapping the remove button on an unplayed track removes it from the queue panel and the DB row is deleted (or marked removed). Subsequent transitions skip it.
- [ ] **V8 (no playlist endpoint at runtime):** Open Vercel function logs while playing through a 5-track session with `maxSongDurationSec = 15`. Confirm zero requests to `/v1/playlists/{id}` or `/v1/playlists/{id}/tracks` happen during the session — only the one-time call at import.
- [ ] **V9 (search):** Typing "Beyoncé" in the search input shows ≥5 results within 1 second. Each result has album art, track name, artist.
- [ ] **V10 (search resilience):** If `/v1/search` returns 429, the search input shows "Spotify rate-limited, try again in Ns" and does NOT crash the queue panel. The rest of the queue UI continues working.
- [ ] **V11 (persistence):** Close the PWA, wait 30s, reopen. The queue panel shows the same list with the same currently-playing highlight and any manually-inserted tracks preserved.
- [ ] **V12 (security):** `/security-review` of the diff returns no flags. No Spotify tokens reach the client. Queue-mutation endpoints reject unauthenticated / non-owned / inactive-session requests with the right status codes.
- [ ] **V13 (cold-context review):** Phase 5 reviewer agent reading only this spec + the diff reports `Recommendation: ship` with zero `block`-severity issues.

---

## Smell Test

- [x] Is every outcome observable from outside the system? **Yes — O1–O8 describe user-visible behavior + observable Spotify API call patterns (V8).**
- [x] Could every verification criterion be falsified by a real test? **Yes — V1–V13 are concrete: track counts, log inspection, response-time bounds, status codes.**
- [x] Is anything in "In Scope" vague? **No — every in-scope item names a specific endpoint, model, or UI behavior.**
- [x] Are there constraints I'm assuming but didn't write down? **The "/me/player/* not rate-limited" assumption is called out in §4. The "search rate limit unknown" caveat is in §3.**
- [x] Could a stranger build this from this spec alone? **Yes, with the existing PartyQueue `getNextSong` reference and ADR 0001's parallel-pipeline pattern. The plan file (to be linked from §4 once written) carries the file-by-file decomposition.**
- [x] Is anything in "Out of Scope" actually load-bearing? **No — drag-to-reorder is ergonomic but not blocking; auto-import on Spotify-side edits is a nice-to-have; podcast support is a separate request.**
