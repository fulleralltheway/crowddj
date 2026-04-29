---
name: Bluegrass DJ
slug: bluegrass-dj
status: signed-off
created: 2026-04-28
signed_off: 2026-04-28
shipped: pending
---

# Bluegrass DJ

> An installable PWA at `/bluegrass` that lets Abigail (Bluegrass Ballroom) run dance-class music — pick a Spotify playlist, control playback on her studio laptop from her phone, with auto-fade at a configurable max-song-duration threshold and graceful announcement-fades — even while her phone is locked.

## 1. Outcomes

- [ ] **O1:** Signed-in user opens `https://www.partyqueue.com/bluegrass` on iPhone Safari, taps "Add to Home Screen," launches the installed icon, and lands on the controls in standalone mode (no Safari chrome) with safe areas respected.
- [ ] **O2:** From the PWA, user picks a Spotify playlist and a Spotify Connect device (the studio laptop), presses Play, and the laptop's Spotify desktop app starts playing that playlist at the user's configured target volume within 3 seconds.
- [ ] **O3:** With max song duration set to 15s and fade duration set to 3s, every track on the playlist plays for ~15s, fades smoothly to silence over the last 3s, and the next track starts at full target volume — repeated continuously without user input.
- [ ] **O4:** O3 still holds when the phone is locked or the PWA is fully backgrounded for the entire duration. The fade and skip happen on schedule with no input from the phone.
- [ ] **O5:** Pressing Pause fades volume to 0 over `fadeDurationSec` then pauses; pressing Resume unpauses at volume 0 and fades up to target over `fadeDurationSec`.
- [ ] **O6:** With "Stop after this song" toggled on, the next threshold-fade ends in a paused state instead of advancing.
- [ ] **O7:** Pressing **End Session** restores the laptop's Spotify volume to the user's target, pauses playback, and stops all server-side activity for that session — subsequent personal Spotify use on the laptop receives no fades, skips, or volume changes from this app.
- [ ] **O8:** After full-app close (PWA killed) and reopen the next day, the user is still signed in (no Spotify re-auth required) and lands on the playlist picker with no zombie session state.
- [ ] **O9 (socket-server down — graceful degrade):** If the Fly.io socket server is unreachable, threshold-fades still fade (no hard cuts):
  - PWA foregrounded → client-side position polling detects threshold and fires the fade-skip endpoint directly. Fade quality is identical to the socket-driven path.
  - PWA backgrounded / phone locked → Vercel Cron (1-minute interval, declared in `vercel.json`) hits `/api/cron/sync-bluegrass` which detects threshold-passed sessions and fires `/api/cron/bluegrass-fade-transition` in-process. Worst-case latency on the fade is ~60s (a song may play up to 60s past its configured threshold before fading), but the fade itself is a smooth ramp, not a hard skip.

## 2. Scope Boundaries

### In Scope

- New route `/bluegrass` (server page + client component) inside the existing `~/spotifyapp` Next.js app.
- New Prisma model `BluegrassSession` (one row per active class).
- New API endpoints under `/api/bluegrass/sessions/[id]/*` for session CRUD, playback control, fade-pause/resume/skip, device list, and current state.
- New cron endpoints `/api/cron/sync-bluegrass` and `/api/cron/bluegrass-fade-transition` (CRON_SECRET-gated, parallel to existing room machinery). `sync-bluegrass` supports `deferFade=true` (socket-driven precise scheduling) and `deferFade=false` (synchronously fires the fade endpoint in-process — used by the external HTTP cron fallback).
- Extension to `socket-server.ts` with a parallel `backgroundSessions` set + sync loop + `triggerSessionFade()` helper. Redeployed to Fly.io.
- **Socket-down fallbacks:**
  - Client-side polling fallback in `BluegrassClient.tsx` — when `socket.connected === false`, the existing 1s state-poll loop also runs threshold detection and fires the fade-skip endpoint directly. No code duplication; same threshold math as the primary client path, just routed to the API instead of via socket events.
  - Vercel Cron at a 1-minute interval, declared in `vercel.json`, calling `/api/cron/sync-bluegrass?deferFade=false`. Auth via the existing `CRON_SECRET` env var (bearer-secret pattern, see memory `reference_vercel_cron_bearer.md`). **Requires a one-time upgrade of the Vercel project from Hobby → Pro** (Hobby caps cron at daily intervals; Pro allows sub-minute). Fly.io socket-up remains the primary path; Vercel Cron is the backup-of-backup.
- PWA assets: `bluegrass-manifest.webmanifest`, four app icons (placeholder), service-worker pre-cache + `CACHE_NAME` bump.
- Reuse of existing Spotify wrappers in `src/lib/spotify.ts`, `buildFadeCurve()` in `src/lib/fade-curve.ts`, NextAuth in `src/lib/auth.ts`, PWA hooks in `src/lib/pwa.ts`.

### Explicitly Out of Scope

- True overlapping crossfade (Spotify Web API can't drive two streams on one device — Abigail enables Spotify's native Crossfade Songs setting on her laptop separately).
- Multi-playlist queueing or in-app playlist editing.
- ~~Background threshold automation when the Fly.io socket server is down — falls back to cron hard-skip (no fade).~~ **Moved to In Scope per O9** — graceful fade-preserving degrade via client polling (foreground) + external GitHub Actions HTTP cron (background).
- Vanity subdomain `bluegrass.partyqueue.com`.
- Final Bluegrass branding (logo, colors, custom icons). v1 ships placeholder icons and a neutral dark theme.
- Push notifications.
- Anonymous-guest support, voting, fingerprinting, request approvals — all PartyQueue concepts, deliberately omitted.
- Schema or behavior changes to the existing `Room` / `RoomSong` / `Vote` / `Guest` models.
- Tablet- or desktop-specific layouts beyond what falls out naturally from a phone-first responsive design.

## 3. Constraints

- **Technical:**
  - Stack: Next.js 16 (App Router), React 19, TypeScript, Tailwind v4, Prisma 7 with `@prisma/adapter-neon`, NextAuth v5 beta, Socket.io 4.8, fade utilities in `src/lib/fade-curve.ts`.
  - Vercel Pro plan: project must be on Pro (not Hobby) so we can declare a 1-minute Vercel Cron in `vercel.json` for the socket-down fallback. Any API route running a fade loop still needs `export const maxDuration = 60`.
  - The Fly.io socket server (`socket-server.ts` → `crowddj-socket`) is the existing background runtime; redeploy via `flyctl deploy --app crowddj-socket`.
  - Spotify Web API requires Premium for playback control (returns 403 otherwise). No workaround.
  - Spotify app is in Development mode — Abigail's Spotify email must be added to the developer dashboard tester list before her first login.
  - All build warnings must be treated as errors (per `~/Hub/.claude/rules/development.md`) — Phase 4 doesn't pass on warnings.
  - Service worker `CACHE_NAME` must be bumped on every deploy that changes client code.
  - NextAuth callback URL is already registered for `partyqueue.com` and `crowddj.vercel.app` — no Spotify dashboard changes needed.
  - Git `user.email` must be `jonathandanfuller@gmail.com` (enforced by `verify_git_email.sh` hook).
- **Time:** No hard deadline. Ship when Phase 5 review says "ship" and Phase 6 QA passes.
- **Compliance / security:**
  - All `/api/bluegrass/*` endpoints `auth()`-gated; cron endpoints `CRON_SECRET`-gated.
  - No Spotify tokens written to client-side storage; access tokens stay server-side in the `Account` table; refresh handled by existing dedup-locked `auth.ts` callback.
  - Phase 5 must include `/security-review` because the change touches auth + external API.
- **Design / UX:**
  - Phone-first, single screen, ≥56pt touch targets.
  - Standalone PWA display, dark theme by default, iOS safe-area aware (use `useAppHeight()` and `viewport-fit=cover`).
  - Match the visual restraint of existing PartyQueue mobile views; no new design language.
  - "End Session" button must be visually distinct (red / destructive) and at the bottom — not easy to hit by accident.

## 4. Prior Decisions This Builds On

- PartyQueue's three-layer transition system (client → socket → cron hard-skip) is the proven backgrounding pattern. See `~/spotifyapp/CLAUDE.md` § "Song Transition System" and `socket-server.ts` `triggerServerFade` / `scheduledFades`.
- `buildFadeCurve()` in `src/lib/fade-curve.ts` is the canonical fade ramp generator (ease-out power 1.8, capped step count). Reuse verbatim in Bluegrass fade endpoints.
- `restoreVolume()` retry helper in `src/app/api/cron/fade-transition/route.ts` is the proven pattern for re-establishing target volume after a fade. Reuse the pattern.
- NextAuth session callback in `src/lib/auth.ts` already handles Spotify token refresh with deduplication. Reuse as-is, no scope changes (`streaming`, `user-modify-playback-state`, `user-read-playback-state`, `playlist-read-private` already cover everything we need).
- PWA hooks in `src/lib/pwa.ts` (`useIsStandalone`, `useAppHeight`, `useNetworkStatus`) have been hardened against iOS quirks; reuse them rather than reinventing.
- Existing memory `feedback_ipad_pwa_gotchas.md` warns about native input sizing, safe areas, viewport on iOS. Honor it in `BluegrassClient.tsx`.

## 5. High-Level Tasks

1. **Schema migration** — add `BluegrassSession` model to `prisma/schema.prisma`, push to production Neon DB via the documented `vercel env pull` + `prisma db push` flow.
2. **API endpoints** — sessions CRUD (`route.ts` + `[id]/route.ts`), play/state/devices, fade-pause/resume/skip (3 endpoints, all `maxDuration = 60`).
3. **Cron endpoints** — `sync-bluegrass` (threshold detection mirroring `sync-rooms` pre-queue logic; supports `deferFade=true|false`) + `bluegrass-fade-transition` (server-side fade + skip + restoreVolume).
4. **Socket server extension** — add `backgroundSessions` Map, `join-session`/`leave-session`/`session-ended` handlers, `syncAllSessions()` setInterval, `triggerSessionFade()`. Redeploy to Fly.io.
5. **Socket-down fallbacks** — (a) client-polling threshold detection in `BluegrassClient.tsx` (auto-engages when `socket.connected === false`), (b) Vercel Cron entry in `vercel.json` running every minute against `/api/cron/sync-bluegrass?deferFade=false` (requires Vercel Pro upgrade — Jonathan to enable on the `crowddj` project before Phase 7 ships).
6. **UI / PWA** — `/bluegrass/page.tsx` (server, auth-gated), `BluegrassClient.tsx` (phone-first single screen), manifest, four icons, Apple meta tags, `public/sw.js` cache extension + `CACHE_NAME` bump.
7. **End-Session kill switch + ADR + tests** — DELETE endpoint that pauses + restores volume + emits socket event + marks session inactive. ADR `0001-bluegrass-session-model.md` (why a separate model, not a `mode` field on Room). Unit-test threshold-detection in `sync-bluegrass` (pure logic).

## 6. Verification Criteria

Each criterion is a specific, falsifiable check. Run before requesting Phase 5 review.

- [ ] **V1 (build):** `cd ~/spotifyapp && npm run build` completes with **zero warnings**.
- [ ] **V2 (auth):** Visiting `/bluegrass` while signed out redirects to `/login?callbackUrl=/bluegrass`. After Spotify sign-in, lands back on `/bluegrass`.
- [ ] **V3 (PWA install — iPhone Safari):** "Add to Home Screen" works. Launching the installed icon shows the page in standalone mode (no Safari URL bar). Top status bar respects iOS safe area; no content under the notch or home indicator.
- [ ] **V4 (start playback):** With Spotify Premium signed in on a laptop with the desktop app open, the device picker lists that laptop. Selecting it + a playlist + Play causes audible playback on the laptop within 3 seconds, at the configured target volume. A `BluegrassSession` row is created with `isActive: true`.
- [ ] **V5 (announcement fade):** With `fadeDurationSec = 3`, pressing Pause produces a smooth volume ramp from target → 0 over ~3 seconds and ends in a paused state. Pressing Resume unpauses at 0 and ramps back up over ~3 seconds.
- [ ] **V6 (skip with fade):** Pressing Skip fades the current track over `fadeDurationSec`, then the next track plays at target volume.
- [ ] **V7 (threshold auto-fade — foregrounded):** With `maxSongDurationSec = 15` and `fadeDurationSec = 3`, the fade starts at ≈12s and the next track is playing at target volume by ≈15s. Repeats for at least 3 consecutive tracks.
- [ ] **V8 (threshold auto-fade — phone locked):** Same as V7 but the phone is locked the entire time. Listening to the laptop, every transition still happens on schedule. Unlocking and reopening the PWA, the now-playing UI catches up to reality within 2 seconds.
- [ ] **V9 (stop after this song):** With "Stop after this song" toggled on, the next threshold-fade ends in a paused state. Music does not auto-advance.
- [ ] **V10 (End Session):** Pressing End Session: pauses laptop playback, restores device volume to the configured target, marks `BluegrassSession.isActive = false` and `closedAt` set, removes the session from the socket server's `backgroundSessions`. Subsequently pressing play in the Spotify desktop app on a different track plays normally, with no fades, skips, or volume changes attributable to this app for at least 5 minutes of observation.
- [ ] **V11 (persistent login):** After V10, fully kill the PWA (swipe-up close on iOS), wait at least 1 hour, reopen. User is still signed in (no Spotify OAuth re-prompt). Lands on the playlist picker (not on a zombie session).
- [ ] **V12 (security):** `/security-review` of the diff returns no flags. Specifically: no Spotify tokens reach the client; all `/api/bluegrass/*` and `/api/cron/*` endpoints reject unauthenticated/unsecreted requests with 401.
- [ ] **V13 (cold-context review):** A Phase 5 reviewer agent reading only the spec + diff (no session memory) reports `Recommendation: ship` with zero `block`-severity issues.
- [ ] **V14 (socket-down + foreground fade):** Manually stop the Fly.io socket server (`flyctl scale count 0 -a crowddj-socket` in a test environment, or block the WebSocket connection at the network layer). With `maxSongDurationSec = 15` and `fadeDurationSec = 3`, with the PWA foregrounded, every threshold-fade still fires within ±500ms of the expected time and produces a smooth volume ramp (not a hard cut). Verified by listening + `getCurrentPlayback` log inspection.
- [ ] **V15 (socket-down + locked phone fade):** Same socket-down condition. Lock the phone. With `maxSongDurationSec = 15` and `fadeDurationSec = 3`, observe the laptop. Within 60s of the configured threshold, every track fades smoothly (not a hard cut) and the next track begins. Vercel Cron logs (Project → Cron Jobs in dashboard) show the `sync-bluegrass` job firing each minute with `200` status.

---

## Smell Test

- [x] Is every outcome observable from outside the system? **Yes — all O1–O8 describe user-visible or device-visible behavior.**
- [x] Could every verification criterion be falsified by a real test? **Yes — V1–V13 are concrete, observable, time-bounded.**
- [x] Is anything in "In Scope" vague? **No — every in-scope item names a specific file or endpoint.**
- [x] Are there constraints I'm assuming but didn't write down? **Premium requirement, Development-mode tester list, git email enforcement, CACHE_NAME bump rule — all called out explicitly.**
- [x] Could a stranger build this from this spec alone? **Yes, with the linked plan + the code references in §4. The plan file at `~/.claude/plans/radiant-sauteeing-matsumoto.md` carries the full file-by-file decomposition.**
- [x] Is anything in "Out of Scope" actually load-bearing? **No — true crossfade is unavailable by API; socket-down fallback is acceptable degradation; branding is cosmetic; subdomain is vanity.**
