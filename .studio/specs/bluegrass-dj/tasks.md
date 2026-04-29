# Bluegrass DJ — Tasks

> Implementation breakdown for Phase 3 (Build). Every task has a verification criterion. Mark `[doing]` when started, `[done]` when its verification passes. Don't move on from a task with a failed verification — fix it first.
>
> Phase boundaries (4 verify, 5 review, 6 QA, 7 ship) live in `~/Hub/development/skills/ship-feature.md` and aren't repeated here.

## Worktree setup

- [ ] **T0 — Create worktree on `feature/bluegrass-dj`**
  - Action: `git worktree add ../bluegrass-dj -b feature/bluegrass-dj` from `~/spotifyapp`. All subsequent tasks happen inside `../bluegrass-dj`.
  - Verification: `git -C ../bluegrass-dj branch --show-current` prints `feature/bluegrass-dj`; `pwd` inside the worktree resolves to a sibling of `~/spotifyapp`.

## Schema

- [ ] **T1 — Add `BluegrassSession` model + push migration**
  - Action: Add the model from spec §"Schema" to `prisma/schema.prisma` with the `@@index([userId, isActive])`. Run `npx prisma generate`. Pull production env (`vercel env pull .env.production.local --environment production`), run `DATABASE_URL=$(...) npx prisma db push`, then `rm .env.production.local`.
  - Verification: `npx prisma generate` succeeds; importing `bluegrassSession` from `@/generated/prisma/client` typechecks; `prisma db push` reports "Database is now in sync"; opening Neon Studio (or `prisma studio`) shows the empty table with the spec'd columns + index.

## API — sessions CRUD

- [ ] **T2 — `/api/bluegrass/sessions` (POST create, GET active)**
  - Action: New `src/app/api/bluegrass/sessions/route.ts`. POST `{ playlistUri, playlistName, deviceId? }` creates a row scoped to the auth'd user. GET returns the user's `isActive: true` session, or `null` if none.
  - Verification: with valid session cookie, `curl -X POST` creates a row and returns 201 with the session JSON; without cookie returns 401; GET returns the same row; calling POST twice while one is already active returns 409 with `{ error: "session_already_active", id }` (avoid duplicate active sessions per user).

- [ ] **T3 — `/api/bluegrass/sessions/[id]` (GET, PATCH, DELETE — DELETE is the kill switch)**
  - Action: New `src/app/api/bluegrass/sessions/[id]/route.ts`. GET returns the session. PATCH accepts any of `{ maxSongDurationSec, fadeDurationSec, targetVolume, stopAfterCurrent, deviceId, playlistUri, playlistName }` and validates ranges. DELETE = kill switch: read current device volume, fade-restore to `targetVolume` (gentle, not instant), `pausePlayback(deviceId)`, set `isActive: false` + `closedAt: now()`, then notify socket via an HTTP hook to the socket server's `session-ended` channel (or via a DB read from socket-server's next sync tick — pick whichever is simpler given the hook surface).
  - Verification: PATCH with bad ranges (`fadeDurationSec: 999`) returns 400; PATCH with valid values updates the row + the in-memory poll on the running PWA reflects new settings within one tick. DELETE: device volume returns to `targetVolume` (verify via `getCurrentPlayback` log), Spotify playback paused, row updated, socket server logs `session-ended`. Subsequent personal Spotify use observed for 5 minutes shows zero interference (no fade, no skip, no volume change).

## API — playback

- [ ] **T4 — `/play`, `/state`, `/devices` endpoints**
  - Action: Three new routes under `src/app/api/bluegrass/sessions/[id]/`. `/play` calls `startPlayback(token, [], deviceId)` with `context_uri: session.playlistUri` then `setVolume(targetVolume, deviceId)`. `/state` wraps `getCurrentPlayback()` and returns `{ trackName, artistName, albumArt, durationMs, positionMs, isPlaying, deviceId, deviceVolume }`. `/devices` wraps `getDevices()`.
  - Verification: `/play` produces audible playback on the chosen device within 3s; if the chosen device isn't visible to Spotify (offline), returns 404 with a clear `{ error: "device_unavailable" }` and the UI can show "open Spotify on the laptop". `/state` returns the trimmed shape only — no full playback object leakage. `/devices` lists every device shown in the user's Spotify connect picker.

- [ ] **T5 — Fade endpoints: `/fade-pause`, `/fade-resume`, `/fade-skip`**
  - Action: Three new routes, all with `export const maxDuration = 60`. Each runs `buildFadeCurve(fadeDurationMs)` and ramps `setVolume` step-by-step. `/fade-pause` ends with `pausePlayback`. `/fade-resume` starts at vol 0, calls `resumePlayback`, then ramps up. `/fade-skip` ramps down, calls `skipToNext`, then uses the `restoreVolume()` retry helper (copy from `cron/fade-transition`) to reset target volume. Each step is `try/catch`'d so one Spotify API blip doesn't abort the ramp.
  - Verification: V5, V6 from the spec — pause and resume produce smooth ~`fadeDurationSec` ramps; skip cuts cleanly with target volume restored. Confirmed by ear plus by sampling `getCurrentPlayback().device.volume_percent` in a tight `while` loop during the ramp (logs show monotonic-ish curve).

## Cron

- [ ] **T6 — `/api/cron/sync-bluegrass` (threshold detection)**
  - Action: New `src/app/api/cron/sync-bluegrass/route.ts`, `CRON_SECRET`-gated. Mirrors `sync-rooms`: for each `isActive: true` session, call `getCurrentPlayback`, compare `progress_ms` to `maxSongDurationSec * 1000` window, return `playing | needs_fade | prequeued_maxdur | session_ended | no_playback | external_track`. Updates `currentTrackUri` + `trackStartedAt` on each pass. Supports `?deferFade=true` (returns `prequeued_maxdur` for socket-server scheduling) and `?deferFade=false` (calls `bluegrass-fade-transition` synchronously when `needs_fade`).
  - Verification: hand-crafted test row with `progress_ms` near threshold returns `prequeued_maxdur` with correct `fadeInMs` + `fadeDurationMs` + `currentTrackUri`. Same row past threshold with `deferFade=false` triggers the fade endpoint synchronously and returns `advanced` — confirmed by inspecting Spotify state.

- [ ] **T7 — `/api/cron/bluegrass-fade-transition` (server-side fade + skip)**
  - Action: New `src/app/api/cron/bluegrass-fade-transition/route.ts`, `CRON_SECRET`-gated, `maxDuration = 60`. Reads session + Spotify token (refresh if expired), runs full fade ramp, `skipToNext`, then `restoreVolume()` retry. Includes the same `expectedSongId` safety check as the existing `fade-transition` (skip if the song already changed).
  - Verification: with a session whose current song is past threshold, calling this endpoint produces a smooth fade then advances to the next track at target volume. Calling it twice in quick succession (race) → second call returns `{ skipped: true, reason: "song_already_changed" }`.

- [ ] **T8 — Add `vercel.json` cron entry**
  - Action: Add `crons: [{ path: "/api/cron/sync-bluegrass?deferFade=false", schedule: "* * * * *" }]` to `vercel.json` (create the file if it doesn't exist; otherwise merge). Ensure the path uses bearer auth via `Authorization: Bearer $CRON_SECRET` (Vercel Cron's documented pattern).
  - Verification: `vercel deploy --prebuilt` (or full deploy) succeeds without `crons.schedule must be daily` errors (proves Pro upgrade is active). Vercel dashboard → Project → Cron Jobs lists the entry as enabled. After 2 minutes, the dashboard shows two `200` invocations with `~120-200ms` durations.

- [ ] **T9 — Unit tests for threshold detection**
  - Action: New `src/app/api/cron/sync-bluegrass/route.test.ts` (Vitest, the framework already in `package.json`). Pure-function tests over a `decideSyncStatus(session, playback)` helper extracted from the route handler. Cover: `maxSongDurationSec < 30` → `playing` (auto-transition disabled); progress < pre-queue → `playing`; pre-queue window → `prequeued_maxdur` with correct `fadeInMs`; past threshold + `deferFade=true` → `needs_fade`; past threshold + `deferFade=false` → calls fade endpoint; external track URI → `external_track`.
  - Verification: `npm run test` passes with at least 6 cases covering the branches above. Coverage report shows 100% of the helper.

## Socket server

- [ ] **T10 — Extend `socket-server.ts` with parallel session machinery**
  - Action: Add `backgroundSessions: Map<string, number>` (sessionId → last activity ts), `BACKGROUND_SESSION_TTL = 4h`, `scheduledSessionFades: Map<string, Timeout>`. New socket events: `join-session(sessionId)`, `leave-session(sessionId)`, `session-ended(sessionId)`. New `setInterval(syncAllSessions, SYNC_INTERVAL)` that calls `/api/cron/sync-bluegrass?deferFade=true&sessionIds=...`, processes results parallel to `syncAllRooms`. Add `triggerSessionFade(sessionId, expectedTrackUri)` calling `/api/cron/bluegrass-fade-transition`. Logs prefixed with `[session:<id>]` to match existing `[<roomCode>]` format.
  - Verification: `npm run dev:socket` locally — connecting a Bluegrass client (`socket.emit("join-session", id)`) appears in `backgroundSessions`. Manually past-threshold the session in DB (`UPDATE bluegrass_session SET track_started_at = now() - interval '20 seconds' ...`) then watch logs — within 5s, `[session:<id>] Triggering server-side fade transition` appears, and Spotify advances. Calling `socket.emit("session-ended", id)` clears the entry.

## Socket-down fallback (client side)

- [ ] **T11 — Client-polling threshold fallback in `BluegrassClient.tsx`**
  - Action: In `BluegrassClient`, the existing 1s `/state` poll loop also runs threshold-detection. When `socket.connected === false` AND `position_ms >= maxSongDurationSec*1000 - fadeDurationMs`, call `/fade-skip` directly (instead of waiting for the socket to push a `prequeued_maxdur` event). Idempotency guard: a `localStorage.bluegrass.lastFadeFiredAt` timestamp prevents firing twice for the same threshold.
  - Verification: V14 from the spec — with the socket connection blocked at the network layer (or `socket-server.ts` stopped locally), foregrounded PWA still produces a smooth fade within ±500ms of the expected time. Confirmed by audio + by checking that the idempotency guard never lets two rapid-fire fades land on the same track.

## UI / PWA

- [ ] **T12 — `/bluegrass/page.tsx` server component (auth-gated)**
  - Action: New `src/app/bluegrass/page.tsx`. Calls `auth()`, redirects to `/login?callbackUrl=/bluegrass` if no session. Looks up the user's active `BluegrassSession` (if any) via Prisma, passes it as a prop to `<BluegrassClient>`. Adds `<link rel="manifest" href="/bluegrass-manifest.webmanifest">` + Apple PWA meta tags (`apple-mobile-web-app-capable=yes`, `apple-mobile-web-app-status-bar-style=black-translucent`, `apple-touch-icon` link to `public/bluegrass/apple-touch-icon-180.png`).
  - Verification: V2 from spec — anonymous → redirect; authenticated with no active session → BluegrassClient renders empty playlist picker; authenticated with active session → BluegrassClient renders the now-playing card hydrated with the right session.

- [ ] **T13 — `BluegrassClient.tsx` (full UI)**
  - Action: New `src/app/bluegrass/BluegrassClient.tsx`. Phone-first single-screen layout per spec §UI. Device picker (top), now-playing card (album art + track + artist + position vs limit), big play/pause, skip + stop buttons, "Stop after this song" toggle, playlist picker, settings sheet (max song duration / fade duration / target volume), red **End Session** button at bottom. Owns: 1s `/state` poll loop, threshold-detection (foregrounded primary path + socket-down fallback path), socket connection + `join-session`, settings persistence to localStorage AND PATCH to server. Uses `useIsStandalone()` + `useAppHeight()` from `src/lib/pwa.ts`. Touch targets ≥56pt; respects iOS safe areas via `env(safe-area-inset-*)` + `viewport-fit=cover`.
  - Verification: V4–V11 from spec, exercised manually in local dev on desktop browser **and** an iPhone via the dev server's local IP. Each verification tick logged before moving on.

- [ ] **T14 — PWA assets (manifest + 4 icons + sw.js extension)**
  - Action: Create `public/bluegrass-manifest.webmanifest` (`name: "Bluegrass DJ"`, `display: standalone`, `start_url: "/bluegrass"`, `scope: "/bluegrass"`, `theme_color`, `background_color`, `icons: [...]`). Generate four placeholder icons in `public/bluegrass/`: `icon-512.png`, `icon-192.png`, `icon-maskable-512.png`, `apple-touch-icon-180.png` — solid color + a "BG" wordmark, generated via `sips` or a tiny Python/Pillow script. Edit `public/sw.js`: bump `CACHE_NAME` (per CLAUDE.md PWA rule), add `/bluegrass` and `/bluegrass-manifest.webmanifest` to the precache list, keep network-first + API-skip behavior intact.
  - Verification: V3 from spec — Lighthouse PWA audit on `/bluegrass` reports "Installable" (no errors). On iPhone Safari, "Add to Home Screen" populates the title + icon correctly. Launching the installed app shows standalone mode (no Safari chrome). Service worker `CACHE_NAME` differs from the previous deploy's value.

## Phase-3 exit criteria

When **all of T0–T14 are `done`** and `npm run build` is clean (no warnings), Phase 3 is complete. Move state.md to Phase 4.
