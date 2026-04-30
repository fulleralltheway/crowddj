# Phase 5 Review — bluegrass-queue
**Reviewer:** cold-context general-purpose agent
**Date:** 2026-04-29
**Commits reviewed:**
- `43a162b` feat(bluegrass-queue): schema + getNextSessionTrack helper
- `c9fd2b9` feat(bluegrass-queue): queue API + search endpoint
- `8f042cd` refactor(bluegrass-queue): fade endpoints use DB queue, drop /v1/playlists
- `e1e2a34` feat(bluegrass-queue): QueueSheet UI + search/insert + import wiring

## Intent match

**partial — but with one defect that breaks the whole feature.**

Schema, ADR alignment, endpoint surface area, and UI shell all match the spec. Build is clean (zero warnings) and 30/30 unit tests pass. However, the core promise of the feature — "after the auto-fade fires for track 1, track 2 plays" (V4) — is **broken by an ordering bug in fade-skip and the cron fade-transition**: `getNextSessionTrack(id)` is called BEFORE `markCurrentPlayed(currentUri)`, so it returns the row representing the *currently-playing* track instead of the next one. The "next" `startPlayback` call then re-plays the same track (or restarts it from 0). V4, V5, and V6 all fail at the first transition.

Beyond that, the lockfile regression from the previous round-1 review (`@emnapi/*` Linux deps deleted) has reappeared, and the `void fetch(/queue/import)` fire-and-forget at session-start has no error path — so a 401/network blip during import leaves the UI stuck on "Loading queue…" with no retry button.

## Stage 1 findings

**No scope creep** — every changed file maps to a §5 task in the spec. The 13-file diff (1023 insertions / 131 deletions) covers schema, queue lib, queue routes, search route, fade-skip refactor, cron-fade refactor, and `BluegrassClient.tsx` UI.

**Missing pieces:**

- **Reorder endpoint not implemented.** Spec §2 In Scope: "list, insert, remove, **reorder**." The reorder endpoint and the corresponding test scenario don't exist. The spec §2 Out of Scope says "Drag-to-reorder in the UI" is out of scope, but a programmatic reorder API was listed as in-scope. Either drop "reorder" from §2 In Scope, or add the endpoint. Currently a wire-level mismatch.
- **Spec §5 task 1 says "`prisma db push` against Neon prod."** The branch contains a schema diff but no migration / no evidence of `db push` having been run. If this is supposed to ship, that step must complete before merge.
- **No spec verification of V8 (no `/v1/playlists/*` traffic at runtime).** The fade-skip refactor (`src/app/api/bluegrass/sessions/[id]/fade-skip/route.ts:1-7`) drops the `getPlaylistTracks` import and `cachedPlaylistTracks` import, and the cron route does the same. Verified by inspection. Good — but no automated check against future regression.
- **Sessions GET (`src/app/api/bluegrass/sessions/[id]/route.ts:33`)** returns the raw Prisma row, which now includes `tracksImported`. Client `SessionRow` type adds `tracksImported?` (`BluegrassClient.tsx:32`). Functional. But the `sessions` list route (`src/app/api/bluegrass/sessions/route.ts`) — used at page load for `initialSession` — was not touched. Verify it returns the new field too. (Inspected: `route.ts` returns the full session, so OK.)

## Stage 2 findings

### Critical

- **`src/app/api/bluegrass/sessions/[id]/fade-skip/route.ts:77` + `src/app/api/cron/bluegrass-fade-transition/route.ts:157` — `getNextSessionTrack` is called BEFORE `markCurrentPlayed`.** `getNextSessionTrack` filters only on `isPlayed: false` (`src/lib/bluegrass-queue.ts:14-19`), with no constraint on `isPlaying`. The currently-playing row has `isPlayed=false, isPlaying=true` AND the lowest `sortOrder` of any unplayed row, so it satisfies the query and gets returned. The fade-skip flow then:
  1. Captures `currentTrackUri` from Spotify (track 1's URI).
  2. `nextRow = getNextSessionTrack(id)` returns row 0 (track 1's row). **Bug.**
  3. Fades volume to 0.
  4. `markCurrentPlayed("T1")` flips row 0 to `isPlayed=true`.
  5. `startPlayback([nextRow.spotifyUri])` — but `nextRow.spotifyUri` is "T1". **Spotify replays track 1 from position 0.**
  6. Updates row 0 to `isPlaying=true`. Now row 0 is `isPlayed=true, isPlaying=true` (broken state).

  Audible behavior on the first fade-skip: track 1 fades out, silence, track 1 starts over from 0. V4/V5/V6 all fail at the first transition. Subsequent fades do advance correctly because step 4's `markCurrentPlayed` cleared row 0's `isPlayed=false`, so `getNextSessionTrack` skips it on the next call.

  Fix options (any one):
  - Move the `markCurrentPlayed` calls (lines 93-94 in fade-skip; 170-171 in cron) BEFORE the `getNextSessionTrack` call.
  - Add `isPlaying: false` to the where clause of `getNextSessionTrack`.
  - Use `where: { sessionId, isPlayed: false, NOT: { spotifyUri: { in: [currentTrackUri, currentLinkedFromUri].filter(Boolean) } } }` in fade-skip (passes URIs through).

  Same defect lives in the cron (`bluegrass-fade-transition/route.ts:157`). Both must move.

- **`package-lock.json` regression — `@emnapi/core` and `@emnapi/runtime` removed (lines 1590-1611 of original lockfile, deleted in diff).** Identical to the regression caught in Round 1 of `bluegrass-dj.md` and addressed in `feedback_npm_lockfile_cross_platform.md`. Lockfile was regenerated on macOS, dropping Linux-only optional native deps. Vercel `npm ci` on Linux build will fail EUSAGE. Fix: `rm -rf node_modules package-lock.json && npm install --include=optional` from a Linux container, commit fresh lockfile.

- **`src/app/bluegrass/BluegrassClient.tsx:429-431` — `void fetch(.../queue/import).then().catch(() => {})` has no failure path.** If the import POST returns 401 / 502 / fails the network entirely, `.catch(() => {})` swallows it silently. `tracksImported` stays at the default `"pending"` forever. The QueueSheet renders "Loading queue…" with no retry button (line 1128-1129 only shows retry when status is `"failed"`). User has no recovery path short of ending and recreating the session. Same pattern at line 661-663 (change-playlist mid-session). Fix: branch on response status. If `!res.ok`, also fire `refreshSession()` so the server-side `tracksImported: "failed"` flag flows back to the client and surfaces the existing retry button. Match pattern: `feedback_vercel_serverless_no_background.md`.

### High

- **`src/app/api/bluegrass/sessions/[id]/queue/insert/route.ts` — race window where `sortOrder = -1` is durable.** Line 79 creates the new row with `sortOrder: -1` as a placeholder, then line 110 calls `assignSortOrders` to fix it up. The whole sequence is NOT in a Prisma `$transaction`. If `getNextSessionTrack` runs concurrently (e.g., a fade-skip fires mid-insert), it will return the new row (sortOrder -1 is the lowest, isPlayed=false). The just-inserted track plays *immediately and ahead of the currently-playing track*. Worse: combined with the Critical-1 bug above, the next fade plays the inserted track even on first transition. Fix: wrap the whole insert in `prisma.$transaction(async tx => ...)`. OR compute the correct sortOrder up-front (find max unplayed sortOrder, insert at max+1 for "end" / playingIdx+1 for "next") so no placeholder is needed.

- **`src/app/api/bluegrass/sessions/[id]/queue/insert/route.ts:65-110` — race between two concurrent inserts on the same session.** Both insert calls read `existingUnplayed` and `lastPlayed` independently, both create new rows, both call `assignSortOrders` over disjoint snapshots. The two `assignSortOrders` `$transaction`s don't see each other; whichever commits second wins. Result: one of the new rows ends up with a `sortOrder` matching another row (or stays at `-1`). Likelihood is small (single-user feature) but Abigail can absolutely double-tap "Play next" on adjacent search results in <100ms. Fix: serialize via `bluegrassSession.update` advisory lock, or use an `INSERT ... RETURNING` with a server-computed sortOrder.

- **`src/lib/bluegrass-queue.ts:39-49` — `assignSortOrders` is not atomic w.r.t. uniqueness.** No `@@unique([sessionId, sortOrder])` on the model. Two rows with the same sortOrder are allowed; ties get arbitrary ordering from Prisma. The current renumbering logic ASSUMES contiguous sortOrders (e.g., insert's `startAt = (lastPlayed?.sortOrder ?? -1) + 1` only works if played tracks are 0..startAt-1 and unplayed are startAt..N). Once any race produces a duplicate, `getNextSessionTrack` is non-deterministic between the duplicates. Fix: add `@@unique([sessionId, sortOrder])` and rebuild the insert/delete flows around explicit transactions.

- **`fade-skip` and `cron-fade-transition` use `startPlayback(uris)` instead of `startPlaybackContext(playlistUri, offset)`.** This is a deliberate consequence of the ADR-0002 "DB queue is source of truth" decision, but it has a UX side effect: Spotify is now playing a 1-track URIs queue, not the playlist context. After the FIRST fade-skip:
  - Spotify's native auto-advance is dead. If the cron is delayed / fails, Spotify won't bridge to the next track when the current one ends naturally.
  - Spotify's user-side crossfade (in their account settings) no longer applies between tracks.
  - If `maxSongDurationSec = 0` (auto-fade disabled), once any manual skip happens, music stops entirely at the next natural track end. Users reasonably expect "auto-fade off" to mean "Spotify plays normally."

  Fix: keep using `startPlaybackContext(sess.playlistUri, sess.deviceId, { uri: nextRow.spotifyUri })` so the playlist context is preserved as the failsafe. The DB queue still drives the explicit URI, but if our cron drops a tick, Spotify keeps moving. This was the explicit pattern in the OLD code (per the deleted comment at fade-skip:60-63: "we use context+offset.uri so Spotify keeps the playlist as the queue context").

- **`BluegrassClient.tsx:956-964 + 966-969` — `queueMicrotask(() => { void refreshQueue(); })` in `useEffect` doesn't bind to lifecycle.** If the QueueSheet unmounts (user closes the sheet) before the microtask fires, `refreshQueue` runs anyway and calls `setLoading/setError/setQueue` on an unmounted component (React 18 silently ignores, but the fetch still consumes a request). In React strict-mode dev, the effect runs twice → two HTTP requests → second response can clobber first via setState. Same hazard for the second effect on `tracksImported`. The lint-rule comment ("queueMicrotask defers the synchronous setLoading...") confuses the symptom (lint warning) with the actual issue (no abort). Fix: use an `AbortController` and call `controller.abort()` in the cleanup, OR a captured `cancelled` boolean checked before each setState.

- **`BluegrassClient.tsx:970-991` — search debounce has a stale-response race.** When `search` changes, the effect's cleanup clears the pending `setTimeout`, but if the timeout already fired and the fetch is in flight, the in-flight fetch's response will still hit `setSearchResults(data.results)` even after a newer keystroke. Classic stale-search. Fix: AbortController, or compare response to the search term that triggered it before applying.

- **`fade-skip` and `cron-fade-transition` — Spotify region relinking is partly handled in `markCurrentPlayed` (two calls, lines 93-94 / 170-171) but NOT in the next-track lookup.** If `currentTrackUri` (relinked) doesn't match any DB row but `currentLinkedFromUri` does, `markCurrentPlayed` for the relinked URI no-ops; the second call (for `linked_from`) finds the row and flips it. Good. But the broader pattern means that if BOTH lookups fail (e.g. queue was re-imported between the playback fetch and now), `getNextSessionTrack` returns the same row repeatedly → infinite re-play loop. The three-tier fallback comment promises "DB queue empty → skipToNext", but the queue isn't empty; it's just out of sync. Fix: if `markCurrentPlayed` returns 0 for both URIs AND the `getNextSessionTrack` row's URI matches `currentTrackUri`, skip forward in the queue (`update where { id: nextRow.id } data: { isPlayed: true }`) before re-querying.

### Medium

- **`src/app/api/bluegrass/sessions/[id]/queue/insert/route.ts:46-51` — body validation has no length caps.** `body.name` and `body.artist` are only checked for truthiness. A 100KB `name` field would persist to the DB. Mild DoS surface (Next.js caps body at ~1MB). Fix: clamp via `String(body.name).slice(0, 300)`.

- **`src/app/api/bluegrass/search/route.ts:30-37` — `q` is `encodeURIComponent`'d and capped at min 2 chars, but no max length and no max bytes.** A 10KB `q` flows to Spotify; Spotify will 400 it but our endpoint relays the call. Fix: cap `q` to e.g. 200 chars before forwarding.

- **`src/app/api/bluegrass/search/route.ts:6-12` — `SearchTrack.duration_ms: number` is non-optional, but Spotify's response could be missing the field for explicit/unplayable tracks.** No fallback at the destructure (`durationMs: t.duration_ms` line 73). If undefined, the client receives `durationMs: undefined`, and the insert flow's `Number.isFinite(body.durationMs) ? ... : 0` saves 0. Functional but the type contract is wrong.

- **`src/app/api/bluegrass/sessions/[id]/queue/[trackId]/route.ts:34-36` — returning 404 for `already_played` is misleading.** The track exists, it's just past. Should be 410 Gone or 409 Conflict, matching the 409 used for `currently_playing` on line 31-33. Inconsistency makes client error handling hard.

- **`src/app/api/bluegrass/sessions/[id]/queue/[trackId]/route.ts:38-54` — DELETE renumbering is not transactional.** The delete + read-remaining + read-lastPlayed + assignSortOrders happen across 4 separate connections. A concurrent insert between any two steps produces gaps or duplicate sortOrders. Fix: wrap in `prisma.$transaction(async tx => ...)`.

- **`src/app/api/bluegrass/sessions/[id]/queue/import/route.ts:104-123` — the transactional truncate-and-rebuild deletes any user-inserted (manually added) tracks that haven't played yet.** If the user "Play next"-inserts a song, then changes playlist (which fires re-import via `BluegrassClient.tsx:661`), all manual inserts vanish silently. Spec §5 task 2 says the import is "idempotent (truncates and re-imports)" so this is documented behavior, but it's surprising. Consider preserving `addedManually = true` rows during truncate, OR add a UI confirmation when changing playlist.

- **`src/app/api/bluegrass/sessions/[id]/queue/import/route.ts:50` — `playlistId` extraction strips only the `spotify:playlist:` prefix.** If `playlistUri` is malformed (e.g. shows `spotify:track:abc` because a bad PATCH slipped through), `playlistId = "track:abc"`, the Spotify URL is `/v1/playlists/track:abc/tracks`, Spotify returns 400 / 404, and the catch sets `tracksImported: "failed"`. Functional but the failure path is opaque. The PATCH validator at `[id]/route.ts:88-92` does check `^spotify:playlist:[A-Za-z0-9]+$`, so this should be safe in practice.

- **`src/app/api/bluegrass/search/route.ts:34-35` — `parseInt(retryAfterRaw, 10) || 30` accepts negative values from Spotify.** `parseInt('-5')` returns `-5` (truthy), then `Math.max(1, Math.min(3600, -5))` → 1. Safe by accident. Same in import route line 72. OK but worth a comment.

- **`BluegrassClient.tsx:1080` — `upcomingTracks = queue.filter((t) => !t.isPlayed)` includes the currently-playing track.** Combined with the highlight render (line 1083: `isCurrent = currentTrackUri != null && t.spotifyUri === currentTrackUri`) and the remove button being suppressed for `isCurrent` (line 1116), the UI is fine. But if Spotify region-relinks the URI and `currentTrackUri` is the relinked form while the DB has the original, the highlight fails AND the user can hit ✕ remove on the currently-playing row (which the API will reject with `currently_playing` — but the row also won't have `isPlaying=true` until a fade-skip flips it, so the API's `track.isPlaying` check fails too, and the row gets DELETED mid-playback). Edge case but real.

- **Spec §3 Constraints — "Touch targets ≥56pt on insert + remove buttons."** Current "Play next" / "Add to end" buttons (`BluegrassClient.tsx:1041-1052`) use `px-2 py-1 text-xs`, which is roughly 28-32pt tall. Fails the spec requirement. Fix: bump to `px-3 py-3` and `text-sm` minimum, with explicit min-height.

- **`src/app/api/bluegrass/sessions/[id]/queue/import/route.ts:104-123` — the transaction has a default 5-second `maxWait`/`timeout` (Prisma interactive transaction default).** A 200-track playlist with 200 `createMany` rows is fast, but combined with the `bluegrassSession.update` it's still under a second. OK, but tag-and-document for posterity. (Prisma 5 default is 5s/5s.)

- **`BluegrassClient.tsx:993-1007` — `insertTrack` doesn't await `refreshQueue()`** (line 1006: `void refreshQueue()`). The optimistic-UI claim from spec §3 Constraints ("Optimistic UI on insert/remove: panel updates instantly") is not implemented. The current code is "pessimistic" — wait for server, then refetch. Visible delay matches the round-trip. Functional but less responsive than spec demands.

### Low / nits

- **`src/app/api/bluegrass/sessions/[id]/queue/insert/route.ts:6` — `TRACK_URI_RE = /^spotify:track:[A-Za-z0-9]+$/`.** Spotify track IDs are exactly 22 base62 chars. `[A-Za-z0-9]{22}` would tighten the check. Not security-critical (we forward to Spotify which validates) but free precision.

- **`src/app/api/bluegrass/search/route.ts:37` — `q` is encoded but Spotify search operators (`artist:`, `album:`, `track:`, `year:`) pass through.** Probably intentional (power users), but worth documenting in the route comment so a future dev doesn't "fix" it.

- **`src/lib/bluegrass-queue.test.ts:18` — `$transaction` mock unwraps array form (`Promise.all`) but the route code now also uses callback-form transactions (`import/route.ts:104`).** The unit tests don't cover the import route, so this isn't a test gap for THIS file, but the mock will misbehave if a future test imports import-route directly. Add a callback-form branch to the mock.

- **`BluegrassClient.tsx:946 + 1004` — error states use `setSearchError` with arbitrary server-detail strings.** No XSS risk in React text rendering, but the strings flow from Spotify's error.message. If Spotify ever returns HTML in `error.message`, it would render as text (good). Just noting.

- **`BluegrassClient.tsx:32` — `tracksImported?: "pending" | "importing" | "imported" | "failed"` uses optional `?`.** Server always returns this field, so optional invites confusion. Drop the `?` and use `?? "pending"` only at the call site (already done at line 672).

- **`src/app/api/bluegrass/sessions/[id]/queue/route.ts:12-20` — GET is auth-gated but does no `session_inactive` 409.** Defaulting to "show queue even after session ended" is fine for read-only, but inconsistent with insert/remove which do reject 409. Tiny consistency nit.

- **`prisma/schema.prisma:165-187` — schema indentation is mixed (the `Bluegrass*` models use spaces matching the diff; the rest of the file is unchanged).** Not a blocker.

- **`prisma/schema.prisma` — `enum TrackImportStatus` values are lowercase (`pending, importing, imported, failed`).** The Prisma codegen exports them as exact strings. The TS literal at `BluegrassClient.tsx:32` matches. Consistent. But the rest of the codebase's enum convention isn't checked. (Generated Prisma file `src/generated/prisma/internal/prismaNamespace.ts:1361` confirms the values.)

- **`public/sw.js:1` — `CACHE_NAME` bumped from `v43` to `v44`.** Good. But the service worker's `PRECACHE_URLS` still includes `/bluegrass` which may cache a `/login` redirect for logged-out installs. Pre-existing nit (also raised in Round 1 of the prior review). Not introduced by this branch.

- **`vercel.json` — not touched in this diff.** But the import route has `export const maxDuration = 60` (line 6), which requires Vercel Pro. Spec §3 Constraints already cover this.

- **`fade-skip` and cron now both call `startPlayback` without a `position_ms` argument.** Spotify defaults to position 0. OK, matches old behavior.

- **`src/lib/bluegrass-queue.ts:14-19` — `getNextSessionTrack` uses `findFirst` ordered by sortOrder.** Spec §3 says this should be O(1) on the `(sessionId, isPlayed, sortOrder)` index. Verified in `prisma/schema.prisma:186` (`@@index([sessionId, isPlayed, sortOrder])`). Postgres will use the index for the ORDER BY + WHERE combo. Good.

- **`BluegrassClient.tsx:599-610` — the "View queue + add songs" button has no aria-label or icon.** Functional but visually plain compared to the other action buttons. Minor.

- **`BluegrassClient.tsx:1109-1112` — loading skeleton is plain text "Loading queue…".** No spinner / progress affordance. Acceptable for v1.

## Security flags

| Severity | Location | Issue |
|---|---|---|
| **none** | All `/api/bluegrass/*` queue routes (`route.ts`, `import/route.ts`, `insert/route.ts`, `[trackId]/route.ts`) and `search/route.ts` | All call `auth()` and 401 on missing user, then ownership-check `sess.userId !== auth_.user.id` (404). No IDOR — user A's session ID + user B's track ID is rejected by the cross-check at `[trackId]/route.ts:28`. ✓ |
| **none** | All routes | No Spotify access tokens flow to client. Search response trims to `{uri, name, artist, image, durationMs}`. Queue response trims to public track metadata. ✓ |
| **low** | `src/app/api/bluegrass/sessions/[id]/queue/[trackId]/route.ts:34-36` | DELETE returns `404 already_played` for played tracks but `409 currently_playing` for the playing track. Both leak the existence of a track owned by the requester (which is fine — user owns the session). Inconsistent status codes are a UX issue, not a security issue. |
| **low** | `src/app/api/bluegrass/search/route.ts:30-37` | `q` is sent to Spotify after `encodeURIComponent`. No SSRF (URL is hardcoded). Spotify operator syntax (`artist:`, `album:`) flows through — by design. Not a flag. |
| **low** | `src/app/api/bluegrass/sessions/[id]/queue/insert/route.ts:46-51` | No length caps on `name`/`artist` fields — DoS surface is mild (Next.js caps body at ~1MB) but worth a `.slice(0, 300)` clamp. See Medium findings. |
| **none** | `src/app/api/cron/bluegrass-fade-transition/route.ts:11-18` | `isAuthorized` accepts both `Authorization: Bearer` and `?secret=`. Matches sibling `sync-bluegrass`. ✓ (Round 1 of prior review fixed this.) |
| **info** | `src/app/api/bluegrass/sessions/[id]/queue/import/route.ts:59` | The `Authorization: Bearer ${accessToken}` header is well-formed; no token leakage to client. Server-side log of the request URL would NOT include the token (header). ✓ |

No blocking security findings.

## Unresolved issues

| Severity | Location | Issue | Suggested fix |
|---|---|---|---|
| **block** | `src/app/api/bluegrass/sessions/[id]/fade-skip/route.ts:77` and `src/app/api/cron/bluegrass-fade-transition/route.ts:157` | `getNextSessionTrack` runs BEFORE `markCurrentPlayed`, returns the currently-playing row, causes `startPlayback` to re-play the same track. V4/V5/V6 fail at the first transition. | Move the two `markCurrentPlayed` calls (fade-skip lines 93-94, cron lines 170-171) to BEFORE the `getNextSessionTrack` call. Alternatively, add `isPlaying: false` to `getNextSessionTrack`'s where clause. Add a regression unit test that proves track 1 is NOT re-selected after a single fade. |
| **block** | `package-lock.json` (lines 1590-1611 of original deleted) | `@emnapi/core` and `@emnapi/runtime` removed; lockfile regenerated on macOS. Vercel `npm ci` on Linux will EUSAGE. Same regression pattern as `feedback_npm_lockfile_cross_platform.md`. | `rm -rf node_modules package-lock.json && npm install --include=optional` from a Linux container, commit. The previous bluegrass-dj review showed this needed re-running once already. |
| **block** | `src/app/bluegrass/BluegrassClient.tsx:429-431` and `:661-663` | `void fetch(.../queue/import).catch(() => {})` swallows failures silently. If the import call returns 401 / network drops, `tracksImported` stays at `"pending"` forever and the QueueSheet shows "Loading queue…" with no retry path. | Branch on `res.ok`. On non-OK, also call `refreshSession()` so the server-side `tracksImported: "failed"` flag flows back to the client and surfaces the existing retry button. If the network itself fails (no response), set a client-side error state and offer a manual retry. |
| **fix-before-ship** | `src/app/api/bluegrass/sessions/[id]/queue/insert/route.ts:71-110` | Insert is not transactional. `sortOrder = -1` placeholder is durable; concurrent `getNextSessionTrack` returns the new row immediately. Two concurrent inserts can leave one with `sortOrder = -1` permanently. | Wrap the create + assignSortOrders in `prisma.$transaction(async tx => ...)`. Compute the correct sortOrder up-front so no placeholder is needed; insert with that sortOrder; then renumber any displaced rows in the same transaction. |
| **fix-before-ship** | `prisma/schema.prisma:166-187` | No `@@unique([sessionId, sortOrder])` on `BluegrassSessionTrack`. Allows duplicate sortOrders, which makes `getNextSessionTrack` non-deterministic between duplicates if any race occurs. | Add `@@unique([sessionId, sortOrder])`. Be aware: the transient `-1` placeholder in insert breaks this unique constraint, so it MUST be paired with the previous fix. |
| **fix-before-ship** | `src/app/api/bluegrass/sessions/[id]/queue/[trackId]/route.ts:38-54` | DELETE delete + read-remaining + read-lastPlayed + assignSortOrders run across 4 connections. Concurrent insert produces gaps or duplicate sortOrders. | Wrap in `prisma.$transaction(async tx => ...)`. |
| **fix-before-ship** | `src/app/api/bluegrass/sessions/[id]/fade-skip/route.ts:108` and `src/app/api/cron/bluegrass-fade-transition/route.ts:193` | Using `startPlayback(uris)` instead of `startPlaybackContext(playlistUri, offset)` discards Spotify's playlist context. After the first skip, Spotify won't auto-advance natively, breaking the failsafe and breaking `maxSongDurationSec=0` UX. | Switch to `startPlaybackContext(accessToken, sess.playlistUri, sess.deviceId ?? undefined, { uri: nextRow.spotifyUri })`. Preserves the "DB queue is source of truth" semantics while keeping Spotify's native auto-advance as a safety net. Matches the old fade-skip pattern (the deleted comment at fade-skip:60-63 explicitly justified this). |
| **fix-before-ship** | `src/app/bluegrass/BluegrassClient.tsx:956-991` | `queueMicrotask` doesn't bind to component lifecycle; search debounce has stale-response race. | Use `AbortController` per effect; abort on cleanup. Drop the `queueMicrotask` workaround — the React-hooks lint rule wants you to either (a) extract the async function and call it at the top of the effect, or (b) accept the warning with `// eslint-disable-next-line` and a comment. The current "defer to microtask" is neither correct nor what the lint rule asks for. |
| **fix-before-ship** | `src/app/api/bluegrass/sessions/[id]/fade-skip/route.ts:93-94` and `cron:170-171` | Region-relinked URI handling is incomplete. If neither `markCurrentPlayed` call matches a row but the next-track lookup returns the same row, infinite re-play loop. | If both `markCurrentPlayed` calls return 0 AND `nextRow.spotifyUri` matches `currentTrackUri`, force-mark `nextRow.id` as played before reading `getNextSessionTrack` again. |
| **fix-before-ship** | `src/app/api/bluegrass/sessions/[id]/queue/insert/route.ts` and `BluegrassClient.tsx:1041-1052` | Spec §3: insert/remove buttons must be ≥56pt touch targets. Current `px-2 py-1 text-xs` is well below. | Bump to `px-3 py-3 min-h-[56px] text-sm`. Verify on iOS Safari with the iPad Air viewport. |
| nit | `src/app/api/bluegrass/sessions/[id]/queue/insert/route.ts:46-51` | No length cap on `name`/`artist`. | `String(body.name).slice(0, 300)`. |
| nit | `src/app/api/bluegrass/search/route.ts:30` | No length cap on `q`. | `q.slice(0, 200)` after trim. |
| nit | `src/app/api/bluegrass/sessions/[id]/queue/[trackId]/route.ts:34-36` | DELETE returns 404 for played, 409 for currently_playing. Inconsistent. | Use 410 Gone for played, keep 409 for playing. |
| nit | Spec §2 | "reorder" is listed as in-scope but no endpoint exists. | Either remove "reorder" from the spec's "list, insert, remove, reorder" enumeration, or add the endpoint. |
| nit | `src/app/bluegrass/BluegrassClient.tsx:993-1006` | Spec calls for optimistic UI on insert/remove, code is pessimistic (refetch after server responds). | Compute the new queue locally and `setQueue()` immediately; on server error, revert and show error. |
| nit | `prisma/schema.prisma:175` | New `tracksImported` column is non-nullable with default `pending`. Existing rows on prod will get `pending` on `db push` — they'll show "Loading queue…" forever even though those sessions never had tracks imported. | If there are pre-existing active sessions on prod, run a one-shot UPDATE setting old rows to `imported` (or accept that those sessions are dead — Abigail can recreate). Document either way. |
| nit | `src/app/api/bluegrass/sessions/[id]/queue/route.ts` GET | No `session_inactive` 409. | Add for consistency with insert/remove. |

## Recommendation

**fix-and-resubmit**

Three blocking issues:

1. **Critical-1** (`getNextSessionTrack` ordering bug) — the feature literally does not work. First fade-skip plays the current track again. This is the V4 acceptance criterion failing at the first hurdle.
2. **Critical-2** (`@emnapi/*` lockfile regression) — Vercel `npm ci` will fail; nothing deploys. Same regression as Round 1 of the prior bluegrass-dj review. The `feedback_npm_lockfile_cross_platform.md` memory exists specifically to prevent this.
3. **Critical-3** (silent import failure) — V13 (cold-context review) requires the spec scenarios to be reachable. With a stuck "Loading queue…" and no retry, V3/V11 are unreachable when the import call fails for any non-rate-limit reason.

Fix-before-ship items (insert non-transactionality, DELETE non-transactionality, missing `@@unique`, `startPlaybackContext` regression, queueMicrotask + AbortController, region-relinking infinite loop, touch-target sizes) should land in the same patch. They're all real defects under realistic conditions; some are race-windows that will only fire 1-in-100 times but each one will be hard to reproduce when it does.

Architecture matches ADR-0002 (parallel pipeline, no `Room`/`RoomSong` regressions). Build is clean, all 30 unit tests pass. Once the blockers are fixed, this is in good shape for Phase 6 QA. But ship it as-is and the very first fade-skip will replay track 1 — Abigail will think the whole feature is broken because, functionally, it is.
