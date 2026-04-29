# Phase 5 Review — bluegrass-dj
**Reviewer:** cold-context general-purpose agent
**Date:** 2026-04-29
**Commits reviewed:**
- `9d2f629` feat(bluegrass-dj): add BluegrassSession model
- `51dee1e` feat(bluegrass-dj): API endpoints for sessions + playback + fades
- `c49732e` feat(bluegrass-dj): sync + fade-transition crons + threshold tests
- `f21edfc` feat(bluegrass-dj): parallel session machinery in socket-server.ts
- `9119565` feat(bluegrass-dj): /bluegrass route, PWA shell, client UI

## Intent match

**partial**

Most of the spec is implemented correctly: schema, CRUD/play/state/devices/fade endpoints, sync + fade-transition crons (both `?secret=` and Bearer), socket-server's parallel `backgroundSessions` machinery, PWA manifest + sw.js bump (`v28` → `v29`), client polling fallback, and the threshold-detection unit tests (all 11 pass).

The intent gaps are concrete:

1. **Spec O3/V7 says `maxSongDurationSec = 15`. The code's `AUTO_DURATION_MIN_SEC = 30` floor (`src/lib/bluegrass-sync.ts:52`) silently disables auto-fade for any value below 30.** The threshold-test even asserts `auto_disabled` for `< 30s` (`src/lib/bluegrass-sync.test.ts:34-39`). The PATCH validator allows 0–600 (`src/app/api/bluegrass/sessions/[id]/route.ts:62-66`), and the SettingsForm slider lets the user set 5–25s with no warning, then silently no-ops. Spec O3 with `maxSongDurationSec = 15` literally cannot pass with this code.
2. **`vercel.json` cron path includes a query string.** Vercel Cron's `path` field does not support query strings — they are documented as not parsed/forwarded for crons. The cron will hit `/api/cron/sync-bluegrass` (no `deferFade=false`). It accidentally still works because the endpoint defaults to `deferFade=false` when the param is missing (`src/app/api/cron/sync-bluegrass/route.ts:76`), but spec line 39 calls out `?deferFade=false` explicitly and the wire-level intent doesn't match the implementation. Fragile.
3. **`bluegrass-fade-transition` "stop after this song" branch never pauses.** Lines 121–130: fade ramps volume to 0, then `restoreVolume(accessToken, sess.targetVolume)` ramps it back up — but `pausePlayback` is never called. The track keeps playing audibly past the threshold at full target volume, then Spotify auto-advances to the next track when the original track naturally ends. Directly breaks O6 / V9.

## Stage 1 findings

**No scope creep** — every changed file relates to the spec.

**Missing pieces:**

- `src/app/api/bluegrass/sessions/[id]/route.ts` — DELETE doesn't emit `session-ended` over the socket itself. It relies on the client to emit. If the client crashes or the network drops between DELETE response and socket emit, the socket server keeps the session in `backgroundSessions` until the next sync tick observes `isActive=false`. Not catastrophic (since `bluegrass-fade-transition` re-checks `isActive` and bails), but redundant safety the spec implies in O7 ("stops all server-side activity for that session").
- No handling of NextAuth `tokenError === "RefreshTokenRevoked"` in any of the bluegrass routes. The existing `src/app/api/spotify/playlists/route.ts` checks for this and returns 401 with `error: "TokenRevoked"`. The bluegrass endpoints just see `accessToken` as missing and return generic 401. Won't break things, but the user gets no signal to re-auth.
- `bluegrass-fade-transition` accepts only `?secret=` (line 64–66) — no `Authorization: Bearer` fallback, unlike `sync-bluegrass`. The socket server uses `?secret=` so this is fine in practice, but it's inconsistent with the other cron endpoint and makes future Vercel Cron migration painful.

## Stage 2 findings

### Critical
- **`src/app/api/cron/bluegrass-fade-transition/route.ts:121–130` — stopAfterCurrent never pauses.** After the fade ramps volume to 0, `restoreVolume(accessToken, sess.targetVolume)` runs without first calling `pausePlayback`. Audible behavior: silence for fade duration, then **full volume returns mid-track** for the rest of the song, then Spotify naturally advances. V9 fails.
- **`src/lib/bluegrass-sync.ts:52` — `AUTO_DURATION_MIN_SEC = 30` defeats spec O3 / V7.** The spec scenario uses `maxSongDurationSec = 15`. With this floor, that scenario reports `auto_disabled` and the cron / socket pipelines never schedule a fade. Either lower the floor to 5 (reasonable for class-music context where a 15s preview is the use case) or rewrite the spec scenarios to use 60s. The unit test on line 34 must change accordingly.
- **`package-lock.json` removes `@emnapi/core` and `@emnapi/runtime` (lines 1590–1611 of original lockfile, deleted in diff).** This is exactly the failure mode in `feedback_npm_lockfile_cross_platform.md` — the lockfile was regenerated on macOS, dropping Linux-only optional deps. Vercel's `npm ci` on Linux will fail with EUSAGE. Re-run `rm -rf node_modules package-lock.json && npm install --include=optional` from a Linux container or before merging.

### High
- **`vercel.json:4` cron path with query string is undefined behavior.** Move `deferFade` parsing to default-false (already true today via `=== "true"` check) and drop the query string from `path`, OR use a separate route like `/api/cron/sync-bluegrass-fallback` whose semantics are explicit. As written, the spec contract and the deployment file disagree.
- **`src/app/api/cron/sync-bluegrass/route.ts:53–69` `fireFade()` is awaited inside the per-session loop.** With `maxDuration = 30` on the sync route and a single fade taking up to ~7–10s (fade ramp + 300ms sleep + 3× restoreVolume retries with 1s sleeps), processing 3+ sessions sequentially in a single cron tick can exceed the 30s ceiling. Mitigations: (a) fire-and-forget with `void`, (b) use `Promise.all` at the end, or (c) raise `maxDuration` to 60. Currently low-traffic (Abigail = 1 session), but it's a latent timeout once the feature scales.
- **Race: client polling fallback + socket reconnect mid-fade.** `BluegrassClient.tsx:101–109` fires `fade-skip` via fetch when `socketConnected === false` and threshold is crossed. If the socket reconnects during the fade ramp, the socket server's `scheduledSessionFades` timer may also fire. localStorage idempotency only protects the client; the server has no in-flight guard for sessions (the per-session `fadingSessions` set in `socket-server.ts:53` is cleared on completion, but a fresh client-fired call won't be visible to that set). Worst case: double-skip. Add an in-flight guard at the route level (e.g., a short-lived DB lock keyed on `sessionId + currentTrackUri`).

### Medium
- **`fade-resume` reverses the down-curve to make an up-curve** (`src/app/api/bluegrass/sessions/[id]/fade-resume/route.ts:43–48`). `buildFadeCurve` is ease-out (`pow(1-t, 1.8)`); reversed it becomes ease-in — quiet for most of the ramp, then a sudden swell at the end. Perceptually less smooth than a true ease-out fade-in. Worth a follow-up (build a dedicated fade-in curve), not a blocker.
- **DELETE volume-restore curve** (`src/app/api/bluegrass/sessions/[id]/route.ts:144–158`): caps the up-ramp at 2 seconds (`Math.min(2000, sess.fadeDurationSec * 1000)`). Spec O7 says "restore the laptop's Spotify volume to the user's target" — the cap is fine, but the math `currentVol + Math.round((sess.targetVolume - currentVol) * mult)` walking `mult` from `1.0 → ~0` (reversed multipliers) means the **first** setVolume call after reverse is at `currentVol + (target - currentVol) * 1.0 = target`. So the first step jumps straight to target, then ramps back down to currentVol. This is the opposite of a ramp-up. The curve direction is wrong here.
- **`bluegrass-fade-transition` race-safety check** (line 86) uses `sess.currentTrackUri`, but `sess.currentTrackUri` is set by `sync-bluegrass` only when the URI changes (line 123–127 of sync-bluegrass). If the user manually skips (via `/api/bluegrass/sessions/[id]/fade-skip`, which sets `currentTrackUri: null` on line 85), and the cron fires before the next sync tick, the race-safety check passes vacuously (null !== expected, but the check is `sess.currentTrackUri && ...`). So it short-circuits. OK in this direction, but the asymmetry deserves a comment.
- **`socket-server.ts:125–134` `session-ended` handler doesn't clear `fadingSessions`.** If a fade is in-flight (very unlikely but possible) and the user ends the session, the next fade-trigger attempt for a recreated session with the same ID would be blocked. The ID is a cuid so reuse is essentially impossible, but the cleanup is asymmetric with `room-closed` (line 205–215 also doesn't clear `fadingRooms` — pre-existing, but worth noting).
- **`socket-server.ts` health check** (line 18–22) only reports rooms-related counts; doesn't surface session counts (`activeSessions.size`, `backgroundSessions.size`). Operationally invisible.
- **`public/sw.js:8` precaches `/bluegrass`.** This route is auth-gated and server-rendered. Network-first means the cache is only fallback, but if a logged-out user installs the PWA, the precache fetch could 302 to `/login` and cache the redirect HTML. Subsequent offline access would serve the login page — confusing but not a security hole. Verify install-time fetch isn't caching a redirect.

### Low / nits
- `src/app/api/bluegrass/sessions/route.ts:13–18` GET returns `null` for "no active session" instead of `404` or an envelope `{session: null}`. Client handles `initialSession: null` correctly (page.tsx:35–40), so functional, but `null` as a 200 body is awkward.
- `BluegrassClient.tsx:240` — `try { getSocket().emit("session-ended", sess.id); } catch {}` after DELETE. The DELETE response itself succeeded; if the socket emit throws, that's silently swallowed. With a DOM-level error, the server cleanup would be delayed until the next sync tick — which is fine, but warrants a comment.
- `src/app/api/bluegrass/sessions/[id]/play/route.ts:51` updates `trackStartedAt` but not `currentTrackUri`. The next sync tick will set it. Fine, but explicit `currentTrackUri: null` on play would be clearer about state-machine intent.
- `bluegrass-manifest.webmanifest` doesn't include the apple-touch-icon-180.png in the `icons` array. Apple ignores manifest `icons` and uses the meta tag (which `page.tsx:17` sets correctly), so no functional break.
- `src/app/api/bluegrass/sessions/[id]/route.ts:8` comment says "give it room past Vercel's 10s default" — the default is 10s on Hobby, 15s on Pro. Minor but the spec hinges on a Pro upgrade.
- `BluegrassClient.tsx:217` — when there's no track played yet, calling `/play` directly for "resume" is correct. But if `play` was already called (track started, then track ended naturally with maxSongDurationSec=0), `playback?.trackName` could still be populated from the previous poll, so the next "Play" press hits `fade-resume` instead of `play`. Edge case, low impact.

## Security flags

| Severity | Flag |
|---|---|
| **none** | All `/api/bluegrass/*` routes call `auth()` and 401 on missing user. Verified at all 7 endpoints. |
| **none** | Cron endpoints reject unauthenticated/unsecreted requests with 401. `sync-bluegrass` accepts both Bearer and `?secret=`; `bluegrass-fade-transition` accepts only `?secret=`. |
| **none** | No Spotify tokens leak to the client. Tokens stay in `Account` table; client only receives session row data (no `accessToken` field on `SessionRow`). |
| **low** | `sess.userId !== auth_.user.id` ownership check is consistent across all routes. No IDOR. |
| **low** | DELETE/POST/PATCH all 404 on missing-or-non-owned session. `session_inactive` returns 409, also fine. |
| **low** | No PII in error responses or logs. Logs use `sess.id` (cuid) and track URIs (public Spotify URIs), not user emails. |
| **info** | Socket server `triggerSessionFade` puts `CRON_SECRET` in URL query string (`socket-server.ts:463`). Already the existing pattern; logged on Fly.io stdout. Not a regression but worth noting that `?secret=` patterns flow through HTTP access logs. |
| **info** | `src/app/api/cron/sync-bluegrass/route.ts:34–37` uses `Buffer.from(...).toString("base64")` for Spotify client creds — env-var sourced, fine. Same in `bluegrass-fade-transition`. |
| **info** | No open-redirect risk; the only redirect is `page.tsx:32` `/login?callbackUrl=/bluegrass` — hardcoded path. |

## Unresolved issues

| Severity | Location | Issue | Suggested fix |
|---|---|---|---|
| **block** | `src/app/api/cron/bluegrass-fade-transition/route.ts:121–130` | `stopAfterCurrent` ramps volume back to target after the fade-down without ever calling `pausePlayback`. Track resumes mid-song at full volume. Breaks O6/V9. | Insert `await pausePlayback(accessToken)` before the `restoreVolume` call. Actually: keep volume at 0, call pausePlayback, then restoreVolume, then update DB. |
| **block** | `src/lib/bluegrass-sync.ts:52` + `bluegrass-sync.test.ts:34-39` | `AUTO_DURATION_MIN_SEC = 30` silently disables auto-fade for spec scenarios using `maxSongDurationSec = 15`. Breaks O3/V7. | Lower floor to 5 (or 10), and update the test to assert `auto_disabled` only below the new floor. SettingsForm slider's min should match. |
| **block** | `package-lock.json` (deletion of `@emnapi/core` + `@emnapi/runtime`) | Lockfile regenerated on macOS dropped Linux-only optional deps; Vercel `npm ci` will EUSAGE on Linux build. Documented in `feedback_npm_lockfile_cross_platform.md`. | Re-run `rm -rf node_modules package-lock.json && npm install --include=optional` from Linux (Docker / Codespaces / Vercel CLI build), commit fresh lockfile. |
| **fix-before-ship** | `vercel.json:4` | Cron `path` includes `?deferFade=false` query. Vercel cron strips query strings; spec contract and config disagree. Currently works by accident. | Drop the query string (default behavior already matches). Add a comment in the cron route making the default explicit. |
| **fix-before-ship** | `src/app/api/cron/sync-bluegrass/route.ts:53–69` (`fireFade`) | Awaiting fade fetch in per-session loop can blow `maxDuration = 30` once 2+ sessions exist. | Fire-and-forget with `void fireFade(...)` (matches PartyQueue room cron pattern), or raise `maxDuration` to 60. |
| **fix-before-ship** | `src/app/api/bluegrass/sessions/[id]/route.ts:144–158` | DELETE up-ramp curve walks reversed multipliers but the formula `currentVol + delta * mult` puts the **first** step at full target, then ramps DOWN to currentVol. Direction inverted. | Walk `multipliers` (down-curve) and use `targetVolume - delta * mult` so volume rises from currentVol → target. Or build a proper ease-in curve. |
| **fix-before-ship** | `BluegrassClient.tsx:101–109` + cron `triggerSessionFade` | Race: client-polling fallback + socket reconnect mid-fade can fire two `fade-*` requests for the same threshold. Server has no in-flight guard at the route level. | Add a DB-level idempotency token: include `lastSyncAdvance` timestamp check (e.g., reject fade if `lastSyncAdvance` updated within last 2*fadeDurationSec). |
| **fix-before-ship** | `src/app/api/cron/bluegrass-fade-transition/route.ts:64–66` | Cron endpoint rejects `Authorization: Bearer` header (only accepts `?secret=`). Inconsistent with sibling `sync-bluegrass` which accepts both. | Mirror the `isAuthorized` helper from `sync-bluegrass`. |
| nit | `src/app/api/bluegrass/sessions/[id]/fade-resume/route.ts:42–48` | Reversed ease-out curve produces ease-in fade — perceptually quiet for most of the ramp then a swell at the end. | Build a dedicated `buildFadeInCurve()` (e.g., `pow(t, 1/1.8)`) and use here + in DELETE up-ramp. |
| nit | All 7 bluegrass routes | No handling of NextAuth `tokenError === "RefreshTokenRevoked"`. | Match `src/app/api/spotify/playlists/route.ts` early-return pattern. |
| nit | `socket-server.ts:18–22` | Health check doesn't surface session counts. | Add `activeSessions: activeSessions.size, backgroundSessions: backgroundSessions.size, scheduledSessionFades: scheduledSessionFades.size`. |
| nit | `socket-server.ts:125–134` | `session-ended` handler doesn't clear `fadingSessions`. | `fadingSessions.delete(sessionId)` for symmetry. |
| nit | `public/sw.js:8` | Precaches `/bluegrass`, which is auth-gated. May cache a `/login` redirect page if installed while logged-out. | Drop `/bluegrass` from `PRECACHE_URLS`; runtime fetch handler will cache it on first hit. |
| nit | `BluegrassClient.tsx:289` | `durationCap = sess.maxSongDurationSec || Math.floor(...)`. When `maxSongDurationSec === 0` the OR falls through; otherwise progress bar caps at threshold. Both intentional but the "(limit)" tag only shows when `>= 30`, asymmetric with the cap shown. | Either show "(limit)" any time `maxSongDurationSec > 0` and song is longer, or hide the cap when below the floor. |
| nit | `prisma/schema.prisma:178` | `maxSongDurationSec @default(120)` — but PATCH allows 0–600 and SettingsForm min is 0. With the AUTO_DURATION_MIN_SEC floor at 30, default is fine; once that bug is fixed, reconsider. | Keep 120; just be consistent with the floor change. |

## Recommendation

**fix-and-resubmit**

Three blocking issues need to land before this can ship:
1. The `stopAfterCurrent` branch must call `pausePlayback`, or V9 will fail in QA.
2. The `AUTO_DURATION_MIN_SEC = 30` floor invalidates the spec's own `maxSongDurationSec = 15` test scenario; either the constant or the spec must change.
3. The lockfile must be regenerated on Linux to restore `@emnapi/*` optional deps; otherwise Vercel build fails.

The other "fix-before-ship" items (vercel.json query, fireFade await, DELETE up-ramp direction, race guard, cron auth parity) are real but smaller. Resolve them in the same patch.

Build is clean (zero warnings), 19/19 unit tests pass. Architecture matches ADR-0001 — parallel pipelines, no cross-contamination with the `Room` / `RoomSong` graph. Once the blockers are fixed, this is in good shape for Phase 6 QA.

## Round 2 (2026-04-29)
**Reviewer:** fresh cold-context general-purpose agent
**Commits since first review:** ccaa3aa fix(bluegrass-dj): address Phase 5 review findings

### Verification of first reviewer's findings

| Round 1 issue | Status | Citation |
|---|---|---|
| **block** stopAfterCurrent never pauses (`bluegrass-fade-transition`) | **addressed correctly** | `src/app/api/cron/bluegrass-fade-transition/route.ts:142-153`. New ordering: pause → 200ms sleep → restoreVolume → clear flag. Volume only returns *after* pause, so the resume-at-target requirement is preserved without an audible artifact. |
| **block** AUTO_DURATION_MIN_SEC = 30 invalidates spec scenarios | **addressed but introduced new issue** | `src/lib/bluegrass-sync.ts:54` lowered to 10. Test `bluegrass-sync.test.ts:41-48` now asserts 15s is *not* auto_disabled. **However, two callers in `BluegrassClient.tsx:96` and `:317` still hardcode `>= 30`. The first is a real defect (V14 still broken), the second is cosmetic.** See New findings below. |
| **block** package-lock.json dropped @emnapi/* Linux deps | **addressed correctly** | `git diff main -- package-lock.json` returns 0 lines. Lockfile is byte-identical to main. Vercel `npm ci` will succeed. |
| **fix-before-ship** vercel.json query-string in cron path | **addressed correctly** | `vercel.json:4` now `/api/cron/sync-bluegrass` with no query. `sync-bluegrass/route.ts:80-83` comment clarifies the default-false behavior. Wire intent and config now agree. |
| **fix-before-ship** fireFade serialized in per-session loop, risks maxDuration | **addressed correctly** | `sync-bluegrass/route.ts:106,146,154-156` collects `firePromises` and `await Promise.all` at the end. `maxDuration` raised 30→60 (line 10). The per-session loop body still has serial `await prisma.account.findFirst` + `getAccessToken` + `getCurrentPlayback`, so it's not fully parallel — but the *fade fires* are parallel, which is the long-tail piece. Acceptable. |
| **fix-before-ship** DELETE up-ramp curve direction inverted | **NOT addressed — and the original finding was wrong.** | I traced the math independently. With currentVol=30, target=75, 8-step reversed multipliers `[0, 0.0249, 0.0866, 0.171, 0.287, 0.434, 0.6, 0.793]`, formula `30 + round(45*mult)` produces 30→31→34→38→43→50→57→66→75. Monotonically increasing. The implementer was correct to leave this alone. The first reviewer misread `currentVol + (target-currentVol)*mult` as if `mult` started at 1; it starts at 0 (because the *reversed* down-curve's first element is the original last element, which is 0). |
| **fix-before-ship** Race: client polling + socket reconnect double-fire | **addressed but introduced edge-case issue** | `fade-skip/route.ts:51-58` and `bluegrass-fade-transition/route.ts:101-109` both use atomic `updateMany` with `lastSyncAdvance < (now - 2*fadeMs)` cooldown. Logic is sound. **However: `play/route.ts:51` already sets `lastSyncAdvance: new Date()` on play start, which can interact badly with the new guard for short-max / long-fade configurations. See New findings.** |
| **fix-before-ship** bluegrass-fade-transition only accepts ?secret= | **addressed correctly** | `bluegrass-fade-transition/route.ts:10-17` `isAuthorized` helper now mirrors sync-bluegrass — Bearer or `?secret=`. |

Adaptive `PREQUEUE_LEAD_MS` clamp (`bluegrass-sync.ts:90`): `Math.min(PREQUEUE_LEAD_MS, Math.floor(maxMs / 3))`. Behavior across the slider range:

- max=10s: lead = min(15000, 3333) = 3.33s. Pre-queue window = 6.66s–10s. Fade fires at end. OK.
- max=15s (spec V7/V14/V15): lead = 5s. Pre-queue 10s–15s. OK and matches the new test at line 81-85.
- max=45s and below: still adaptive. lead = max/3.
- max=45s and above: lead = 15s (the original cap). Same behavior as PartyQueue.
- max=300s: lead = 15s. OK.

Math holds across the full slider range (min=0, max=300, step=5). Below 10s the auto_disabled branch short-circuits before the lead calculation, so no division-by-tiny-number issues.

### New findings

#### blocker — Client-polling fallback still gated at >=30s; spec V14 still fails

`src/app/bluegrass/BluegrassClient.tsx:96`:

```
data.isPlaying &&
data.positionMs != null &&
s.maxSongDurationSec >= 30
```

The implementer lowered `AUTO_DURATION_MIN_SEC` from 30 → 10 in the server-side library and updated the slider hint text (line 643), but did not update the client-polling threshold gate. Result: when the Fly.io socket is down and the PWA is foregrounded, **for `maxSongDurationSec < 30` the client never fires the fallback fade**. Spec V14 explicitly tests the socket-down + foregrounded case at `maxSongDurationSec = 15`. With this gate, the PWA will silently let tracks play to natural end at full volume — exactly the failure mode V14 is meant to detect.

Fix: import `AUTO_DURATION_MIN_SEC` from `@/lib/bluegrass-sync` (or duplicate the constant here with a comment) and use it at line 96. Also update the cosmetic `>= 30` at line 317 the same way for symmetry.

#### high — `play/route.ts:51` writes lastSyncAdvance, can deadlock the new fade guard

`src/app/api/bluegrass/sessions/[id]/play/route.ts:49-52`:

```
await prisma.bluegrassSession.update({
  where: { id },
  data: { lastSyncAdvance: new Date(), trackStartedAt: new Date() },
});
```

The new concurrency guard in `bluegrass-fade-transition` and `fade-skip` will only claim if `lastSyncAdvance < (now - 2 * fadeDurationSec * 1000)`. Setting `lastSyncAdvance = now` at play time means the first auto-fade after play is blocked unless `(maxSongDurationSec - fadeDurationSec) > 2 * fadeDurationSec` — i.e., `max > 3 * fade`.

Slider allows `max ∈ [0, 300]` and `fade ∈ [1, 10]`. Counterexamples that pass validation but are blocked:

- `max=15, fade=6` → first fade scheduled at ~9s, cooldown 12s, blocked.
- `max=10, fade=10` → blocked indefinitely (cooldown 20s, threshold every 10s).
- `max=20, fade=10` → blocked.

At spec defaults (max=15, fade=3) the math survives by 6s, but the slider lets users walk straight into a silent failure. The guard never claims, the cron returns `concurrent_transition_in_flight`, no fade ever fires.

Fix: don't set `lastSyncAdvance` in `/play`. The `trackStartedAt` write is fine. Or carve `lastSyncAdvance` semantics to mean "last advance-or-skip" only, not "last play."

#### high — Cooldown blocks legitimate fade retries on transient failure

`bluegrass-fade-transition/route.ts:103-109`: the atomic claim runs *before* `getCurrentPlayback`, `setVolume` retries, or `skipToNext`. If any of those fail mid-flight (Spotify 502, network glitch, token-just-expired race), the fade aborts but `lastSyncAdvance` stays set to the failed-claim time. The next sync tick (5s later from the socket server, 60s from Vercel Cron) will be inside the 2*fadeMs cooldown and bail out with `concurrent_transition_in_flight`. Result: a single transient Spotify failure produces a 6–20 second window where retries are silently dropped.

Specifically, line 157-160's `skip_failed` path returns 502 *without resetting* `lastSyncAdvance`. The track keeps playing past threshold; the next attempt is locked out for 2*fadeMs.

Fix: on any failure path that returns before successfully completing the fade, write `lastSyncAdvance` back to its original value. Or: only claim the cooldown after the fade has actually completed (write at the bottom of the success path). The atomic-read-old-then-write-new can be done with `findUnique` first then `updateMany WHERE lastSyncAdvance = $oldValue` for proper CAS — Prisma supports this.

#### medium — `fade-pause` fallback path doesn't clear `stopAfterCurrent`; behavior diverges from socket-driven path

`bluegrass-fade-transition/route.ts:151` clears `stopAfterCurrent: false` after a stop-after-this-song fade.

`BluegrassClient.tsx:106` — when socket is down and `stopAfterCurrent=true`, the client-polling fallback POSTs to `fade-pause` instead of `fade-skip`. `fade-pause/route.ts` does not clear `stopAfterCurrent`. So the user-visible toggle behavior is socket-up: toggle clears itself after one fade; socket-down: toggle remains set. The spec doesn't mandate either behavior, but the divergence is a latent bug (e.g., the user re-enables auto-advance, hits play, toggle is still on from yesterday → next track gets paused unexpectedly).

Fix: pick one. If the socket-up clear-after-fire is intentional, mirror it in `fade-pause`. If not, drop the clear in `bluegrass-fade-transition`.

#### medium — `fade-resume` and DELETE up-ramp produce a perceptual ease-in (delayed swell) instead of ease-out

`fade-resume/route.ts:42-48` and `route.ts:147-154` both reuse `buildFadeCurve` (which is ease-out for fade-OUT) and reverse it. Reversing an ease-out down-curve gives an ease-in up-curve: the multiplier stays small for most of the duration, then swells at the end. Perceptually this is "music starts inaudibly, then suddenly arrives." Spec V5 says "smooth volume ramp from target → 0" and "ramps back up over ~3 seconds" — the up-ramp violates the implicit symmetry.

This is a cosmetic / UX issue, not a functional bug. The first reviewer flagged this as a nit. Round 2 confirms it's still present and still a nit.

Fix (deferrable): add `buildFadeInCurve()` to `src/lib/fade-curve.ts` using `1 - pow(1-t, 1.8)` or `pow(t, 1/1.8)` and use it for fade-resume and DELETE up-ramp.

#### low — Concurrent-transition response is `200 { skipped: true }` not `409`

`fade-skip/route.ts:57` and `bluegrass-fade-transition/route.ts:108` return HTTP 200 with `{skipped: true, reason: "concurrent_transition_in_flight"}`. From the caller's perspective (socket server, Vercel Cron, client polling) a 200 looks like success. If the client polling fallback hits this and gets a 200, it sets `localStorage[FADE_FIRED_KEY]` and silently moves on — but in the client-polling case there's no other transition in flight (that's why polling fired it). The atomic write on the server prevented the duplicate, fine. But for observability, returning 409 with the same body would let monitoring distinguish "duplicate suppressed" from "actually advanced."

Not a blocker; consider for next pass.

#### low — `fade-pause` doesn't have the cooldown guard; double-pause races aren't protected

The new updateMany cooldown only guards `fade-skip` and `bluegrass-fade-transition`. `fade-pause` and `fade-resume` are not guarded. In the socket-down + `stopAfterCurrent=true` path, the client-polling fallback fires `fade-pause`, and the socket server's reconnect could fire `bluegrass-fade-transition` (which now has a stopAfter branch that pauses). Result: two pauses + two volume-restores in flight. Final state is correct (paused at target volume), but the 200ms sleep + restoreVolume retries can produce an audible re-volumeup-then-down artifact.

Fix: add the same updateMany guard to `fade-pause`. Low priority since the audible artifact is brief and only in fallback mode.

#### low — sw.js precaches /bluegrass which is auth-gated (carryover from round 1, not addressed)

`public/sw.js:7` still includes `/bluegrass` in `PRECACHE_URLS`. Round 1 flagged this. Round 2 finding: when an unauthenticated user visits `/bluegrass`, `page.tsx:32` redirects to `/login?callbackUrl=/bluegrass` (302). Service worker `addAll` follows redirects by default, so the cache key `/bluegrass` ends up holding the login HTML. Subsequent offline navigation to `/bluegrass` serves the login page indefinitely (until cache bump). Confusing, not a security hole.

Fix: drop `/bluegrass` from `PRECACHE_URLS`. Runtime fetch handler caches it on first authed hit anyway.

#### low — socket-server health check still doesn't surface session counts (carryover, not addressed)

`socket-server.ts:20` still only reports `rooms`, `backgroundRooms`, `scheduledFades`. Round 1 flagged. Operationally invisible; harmless.

### Security pass (round 2)

Re-verifying the round 1 security flags after the diff:

| Boundary | Status | Notes |
|---|---|---|
| auth() gate on all /api/bluegrass/* | **pass** | All 7 routes call auth() and 401 on missing user.id. Owner check `sess.userId !== auth_.user.id` consistent. No IDOR. |
| Cron secret gate | **pass** | `sync-bluegrass:12-21` and `bluegrass-fade-transition:10-17` both verify `CRON_SECRET` via Bearer or `?secret=`. Both early-return false if env unset. |
| No Spotify tokens to client | **pass** | `state/route.ts` and `devices/route.ts` strip token. `SessionRow` shape (BluegrassClient.tsx:21-31) has no token field. `auth_.accessToken` accessed server-side only. |
| New updateMany guard | **pass for security** | An attacker who could spam `/api/bluegrass/sessions/[id]/fade-skip` would need a valid session for the owning user (auth-gated). They can't grief another user's session. They CAN grief their OWN session (set `lastSyncAdvance` to now → block the auto-fade for 2*fadeMs). Self-grief is not a real attack class. |
| New Bearer auth path on bluegrass-fade-transition | **pass** | Constant-time comparison? No — JS string `===` is timing-sensitive in principle. Same as the existing `?secret=` check on sibling routes. Existing pattern, not a regression. Worth a follow-up to use `crypto.timingSafeEqual` on all cron paths. |
| sw.js precache → cached login redirect | **info** | Not a security hole; redirect HTML doesn't leak secrets. Confusing UX only. |
| Logs / PII | **pass** | Logs use cuid session IDs and Spotify track URIs. No emails, no tokens. |

No new security flags introduced by the fix commit. The updateMany cooldown is a self-grief surface only, which is not exploitable across users.

### Unresolved issues

| Severity | Location | Issue | Suggested fix |
|---|---|---|---|
| **block** | `src/app/bluegrass/BluegrassClient.tsx:96` | Client-polling fallback hardcodes `>= 30`; spec V14 (socket-down + foreground at maxSongDurationSec=15) cannot pass. The library constant was lowered but this caller wasn't updated. | Import `AUTO_DURATION_MIN_SEC` from `@/lib/bluegrass-sync` and use it. Also fix line 317 for symmetry (cosmetic). |
| **high** | `src/app/api/bluegrass/sessions/[id]/play/route.ts:51` | Setting `lastSyncAdvance: new Date()` on play interacts with the new cooldown guard. For configurations where `maxSongDurationSec < 3 * fadeDurationSec` (e.g., max=10/fade=10, max=15/fade=6, max=20/fade=10), the first fade after play is silently dropped as `concurrent_transition_in_flight`. Validators allow these settings. | Drop the `lastSyncAdvance` write from `/play`. Keep `trackStartedAt`. |
| **high** | `src/app/api/cron/bluegrass-fade-transition/route.ts:103-109` and `:157-160` | Cooldown is claimed *before* the fade-and-skip operation. Any transient failure (skipToNext 502, network) leaves the cooldown active, blocking retries for 2*fadeMs. | Reset `lastSyncAdvance` on failure paths, or move the claim to after success (using a CAS-style updateMany WHERE oldValue=...). |
| **medium** | `BluegrassClient.tsx:106` ↔ `bluegrass-fade-transition:151` | `stopAfterCurrent` flag clears in the cron path but not in the client-polling fallback path (which calls `fade-pause`). Behavior diverges based on socket connectivity. | Pick one semantic. Either clear in `fade-pause` too, or stop clearing in the cron. |
| **medium** | `fade-resume/route.ts:42-48`, `route.ts:147-154` | Reversing an ease-out fade-out curve produces an ease-in up-ramp. Subjectively "delayed swell." Spec V5 implies a symmetrical fade-up. | Add `buildFadeInCurve()` to `src/lib/fade-curve.ts`. |
| low | `fade-skip/route.ts:57`, `bluegrass-fade-transition/route.ts:108` | Returns 200 on duplicate-suppression. 409 would be more honest for callers. | Status 409 with same body. |
| low | `fade-pause`, `fade-resume` | No cooldown guard; double-pause race in fallback paths can produce brief audible artifact. | Optional: add same updateMany guard. |
| low | `public/sw.js:7` | Precache of `/bluegrass` may cache a login redirect for unauthed installs. Carryover from round 1. | Drop from `PRECACHE_URLS`. |
| low | `socket-server.ts:18-22` | Health check lacks session counts. Carryover. | Add `activeSessions.size`, `backgroundSessions.size`, `scheduledSessionFades.size`. |

### Recommendation

**fix-and-resubmit**

The blocker from round 1 about `AUTO_DURATION_MIN_SEC` was only partially addressed: the constant was lowered, but the client-side caller in `BluegrassClient.tsx:96` was missed. As written, spec V14 (socket-down + foregrounded auto-fade at `maxSongDurationSec=15`) still cannot pass — the client polling fallback short-circuits the threshold check.

The new concurrency guard correctly closes the round-1 race window, but it interacts badly with the existing `lastSyncAdvance` write in `/play` (high severity — silently breaks several valid slider configurations) and with transient-failure recovery (high severity — a single Spotify 502 locks out retries for 2*fadeMs).

The other round-1 fixes landed correctly: the lockfile is byte-identical to main, vercel.json is clean, the stopAfterCurrent pause-then-restore is correctly ordered, the parallel fireFade is correct, the Bearer-auth parity matches. The implementer's rebuttal of the DELETE up-ramp finding is mathematically correct — that line is fine and should not change.

Build and tests are clean (21/21 vitest, zero warnings on `npm run build`). Architecture still matches ADR-0001.

The two highs and the missed blocker should land in one focused fix patch. After that, this is shippable.

## Round 3 (2026-04-29)
**Reviewer:** fresh cold-context general-purpose agent
**Commits since round 2:** `89e3d35` fix(bluegrass-dj): address Phase 5 round-2 review findings

Build: clean, zero warnings. Tests: 21/21 passing. Branch tip is `89e3d35`, 7 commits since main as expected.

### Verification of round-2 findings

| Round 2 issue | Status | Evidence |
|---|---|---|
| **block** Client polling fallback hardcoded `>= 30` | **addressed correctly** | `src/app/bluegrass/BluegrassClient.tsx:6` imports `AUTO_DURATION_MIN_SEC` from `@/lib/bluegrass-sync`. Line 99 uses it in the gate. The cosmetic line at 317 was NOT updated for symmetry — but round 2 explicitly tagged that one as cosmetic, not the blocker. Spec V14 (max=15 + socket-down) now passes the gate (15 >= 10). |
| **high** `play/route.ts:51` writes `lastSyncAdvance` and deadlocks tight configs | **addressed but underlying bug remains — see new finding below** | `src/app/api/bluegrass/sessions/[id]/play/route.ts:53-56` no longer touches `lastSyncAdvance`. Comment block at 49-52 explains why. **However** the schema default `@default(now())` at `prisma/schema.prisma:177` still sets `lastSyncAdvance = now()` at session create, and even after the first fade succeeds, the cooldown gate still blocks every subsequent track-to-track auto-fade for any config where `maxSongDurationSec < 2 * fadeDurationSec`. New blocker. |
| **high** Cooldown locked retries on transient fade failure | **addressed correctly** | `bluegrass-fade-transition/route.ts:113-120` defines `releaseCooldown()` helper that sets `lastSyncAdvance` back to the original `cooldownCutoff`. Called on `no_token` (line 126), `token_refresh_failed` (line 132), `skip_failed` (line 172). Math: next attempt at T_retry computes new cutoff = T_retry − 2·fadeMs; restored value (T_claim − 2·fadeMs) < new cutoff iff T_claim < T_retry, i.e., any forward time movement unblocks retries. ✓. Same pattern applied in `fade-skip/route.ts:85-90` for the user-facing endpoint. ✓. |
| **medium** `stopAfterCurrent` flag clearing diverged client vs cron | **addressed** | `BluegrassClient.tsx:113-119` PATCHes `stopAfterCurrent: false` alongside the `fade-pause` POST in the threshold-fallback path. The PATCH and the fade-pause race, but `fade-pause/route.ts` doesn't read or care about `stopAfterCurrent`, so race is harmless — final state matches cron-driven path. Acceptable. |
| medium fade-resume/DELETE up-ramp = ease-in (carry-over) | **not addressed** | Still present. Round 2 noted as nit. |
| low 200 vs 409 on `concurrent_transition_in_flight` (carry-over) | **not addressed** | Still 200. Carry-over. |
| low `fade-pause`/`fade-resume` lack cooldown guard (carry-over) | **not addressed** | Still ungated. Carry-over. |
| low `sw.js` precaches `/bluegrass` (carry-over) | **not addressed** | Round 1, round 2, round 3 — still in `PRECACHE_URLS`. |
| low `socket-server.ts` health check missing session counts (carry-over) | **not addressed** | Still rooms-only. Carry-over. |

### New findings

#### blocker — Cooldown gate silently blocks ongoing auto-fades whenever `maxSongDurationSec < 2 * fadeDurationSec`

The round-2 fix to `play/route.ts` removed one trigger of the cooldown deadlock, but the **deeper invariant** is unchanged: after fade #N succeeds, the cooldown guard sets `lastSyncAdvance = claim_time(T_N)`. The next track plays from Spotify position 0; `decideSyncStatus` (`src/lib/bluegrass-sync.ts:95`) fires `needs_fade` when `progress_ms >= maxMs`, which lands at wall-time ≈ T_N + maxSongDurationSec. The fade-transition cooldown gate (`bluegrass-fade-transition/route.ts:101-109`):

```
cooldownCutoff = now - 2 * fadeMs
claim WHERE lastSyncAdvance < cooldownCutoff
```

For fade #N+1: `now ≈ T_N + max`, `cooldownCutoff ≈ T_N + max - 2*fade`. The claim succeeds iff `lastSyncAdvance(T_N) < T_N + max - 2*fade`, i.e., **`max > 2*fade`**.

Validator allows `maxSongDurationSec ∈ [0, 600]` (`src/app/api/bluegrass/sessions/[id]/route.ts:62`) and `fadeDurationSec ∈ [1, 30]` (line 69). Concrete configurations within the validators that **silently fail every track-to-track auto-fade after the first**:

| config | `2*fade` | `max < 2*fade`? | result |
|---|---|---|---|
| max=10, fade=10 | 20 | yes | every fade after first dropped |
| max=15, fade=10 | 20 | yes | every fade after first dropped |
| max=15, fade=8 | 16 | yes | dropped |
| max=20, fade=10 | 20 | no (boundary) | works |
| max=15, fade=3 (spec V7) | 6 | no | works |
| max=15, fade=6 | 12 | no | works |

The round-2 review asserted the high was "addressed" once `play/route.ts` stopped writing `lastSyncAdvance`. That claim is wrong for ongoing fades: the cooldown sets `lastSyncAdvance` from inside the fade-transition itself (the atomic claim at line 105), so the next fade is always exactly `(max − fade)` away from the previous claim, and the cooldown window is `2*fade`. If `max - fade < 2*fade` (i.e., `max < 3*fade`), even the **wall-time** until the next threshold is shorter than the cooldown — and the cooldown wins.

Worse: the **schema default** `lastSyncAdvance @default(now())` at `prisma/schema.prisma:177` reproduces this for the **first** fade of a freshly-created session whenever the user hits Play within `2*fade` of session creation:

- max=15, fade=6 → first threshold at T_play+9. cutoff = T_play+9-12 = T_play-3. lastSyncAdvance(T0) < T_play-3 requires T_play - T0 > 3s. Realistic setup time (>3s) saves this in practice but it's a contrived race.
- max=10, fade=10 → first threshold at T_play+0. cutoff = T_play-20. Setup must take >20s. Borderline plausible.

So the schema default is a milder version of the same root cause; the ongoing-fades case is the real blocker.

**Fix candidates:**

1. **Tighten the validator to enforce `maxSongDurationSec >= 3 * fadeDurationSec`** (or 2*fade). Reject the slider configurations that the cooldown silently disables. This is the correct semantic: if the user picks tight values that physically can't work with the cooldown, tell them at PATCH time, don't silently drop fades.
2. **Make the cooldown adaptive**: set cooldown = `min(2*fadeMs, max(fadeMs, maxMs/3))` so it never exceeds the threshold window.
3. **Drop the cooldown entirely** and rely on the in-memory `fadingSessions` set + the upstream `expectedTrackUri` check (line 94). The cooldown was added in round 2 to close the client-polling + socket-reconnect race. That race could also be closed by tracking the in-flight URI at the DB level (e.g., `fadingFromUri` column) without a wall-time window.

The simplest landing today is option (1): bump the validator. The `bluegrass-sync.ts:54` floor at `AUTO_DURATION_MIN_SEC = 10` already documents a class of configs that "shouldn't be allowed." Add a similar pairwise constraint.

#### high — Cooldown release on `releaseCooldown()` failure swallows the unlock

`bluegrass-fade-transition/route.ts:113-120`:

```ts
const releaseCooldown = async () => {
  try {
    await prisma.bluegrassSession.update({
      where: { id: sess.id },
      data: { lastSyncAdvance: cooldownCutoff },
    });
  } catch {}
};
```

If the prisma.update itself fails (e.g., transient DB connectivity, the same kind of failure that triggered the outer `releaseCooldown` call), the cooldown stays at the claim value. The next 2·fadeMs of retries are silently dropped. This is the same low-impact case the briefing flagged for the trailing success-path `prisma.update`, but it's now ALSO present on the no-token / token-refresh-failed / skip-failed early-return paths.

In practice DB connectivity failures usually mean the next attempt will *also* fail to read the session, so it's self-cancelling. But under partial outage (read works, write fails), the system gets stuck.

Not a blocker; flag for follow-up. Could be solved by making the release a CAS: `updateMany WHERE lastSyncAdvance = $claimedTime SET lastSyncAdvance = $cutoff` so that successful concurrent writes don't fight each other.

#### high — `releaseCooldown` not called on `stopAfterCurrent` path nor on success path; also no release if trailing `prisma.update` fails

`bluegrass-fade-transition/route.ts`:
- Line 155-167 (stopAfterCurrent): does NOT call `releaseCooldown`. **This is intentional and correct** — the song was successfully paused; the cooldown should remain to prevent immediate re-fire on the next sync tick. ✓
- Line 169-186 (success): does NOT call `releaseCooldown`. **Intentional and correct** — the skip succeeded; cooldown protects against duplicate firing for 2·fadeMs. ✓
- Line 180-186 (trailing `prisma.update` for `trackStartedAt` and `currentTrackUri: null`): **if this throws after `skipToNext` succeeded**, the cooldown stays at claim time, but `trackStartedAt` doesn't bump. The next sync tick observing the actual Spotify track-change will call `prisma.update` itself (sync-bluegrass:135-140), so `trackStartedAt` will recover after one tick. By then, lastSyncAdvance is also old enough for the next fade. **Low impact, self-healing.** Confirm and move on.

So the briefing's predicted "trailing prisma.update failure leaves cooldown stuck" is mathematically real but operationally low-impact, agreed. The bigger concern is the new finding above (#blocker).

#### medium — Race between client-side PATCH and `fade-pause` body still has a corner case

`BluegrassClient.tsx:109-119`: client fires `fade-pause` POST and `PATCH stopAfterCurrent: false` essentially simultaneously. The PATCH validator at `route.ts:81-83` accepts `stopAfterCurrent: false` and writes it. The `fade-pause` route reads `sess` once at line 20 (before the fade ramp), so it never reads the updated value anyway. So far so good — but if the PATCH lands AFTER `fade-pause` reads `sess` and BEFORE `fade-pause` returns, the response back to the client lags the actual DB state. The next state-poll (line 87) fetches the session row, sees `stopAfterCurrent: false`, and the UI updates correctly. **No functional bug; the race just means the UI has stale state for the duration of the fade ramp** (~3s). Acceptable.

#### medium — `fade-skip/route.ts` allows the user-facing skip even when `stopAfterCurrent` is set; behavior is "skip, then the toggle remains on"

`fade-skip/route.ts` doesn't read or update `stopAfterCurrent`. If the user has the toggle ON and presses Skip manually, the song fade-skips (advances), but `stopAfterCurrent` stays ON, and the next threshold-fade will pause. This is consistent with the "toggle is sticky until threshold-fade clears it" model, but the user might expect "Skip" to also turn off the toggle (since they're explicitly advancing). Not a regression from this fix commit; pre-existing.

#### low — Comment at `bluegrass-fade-transition/route.ts:179` is stale

Line 179 says "lastSyncAdvance was already set by the concurrency-guard updateMany above." True for the success path. But misleading because the file ALSO has a `releaseCooldown` helper that sets `lastSyncAdvance` BACK to the cutoff on early-return paths. A reader skimming this comment alone would miss the early-return mutation.

Same comment in `fade-skip/route.ts:101`.

Suggest: "lastSyncAdvance is already at claim time from the cooldown guard at line 52-58. Don't overwrite it on the success path; the claim time is the correct cooldown anchor."

#### low — Cosmetic `>= 30` at `BluegrassClient.tsx:317` was not updated to use `AUTO_DURATION_MIN_SEC`

The implementer fixed line 96 (the gate) but left line 317 (the cosmetic "(limit)" tag display) at the literal `>= 30`. Round 2 explicitly called this out: "Also fix line 317 for symmetry (cosmetic)." Round 2 was not addressed. Functional impact: the "(limit)" badge now shows for max=30+ but the auto-fade actually engages at max=10+. Slight UI inconsistency.

### Security pass

No new security flags. The `releaseCooldown` write is auth-gated upstream (the cron endpoint requires CRON_SECRET; the user-facing `fade-skip` requires session ownership). No new attack surface.

### Final unresolved issues

| Severity | Location | Issue | Suggested fix |
|---|---|---|---|
| **block** | `prisma/schema.prisma:177` + cooldown logic at `bluegrass-fade-transition/route.ts:101-105` | Cooldown silently blocks every track-to-track auto-fade after the first when `maxSongDurationSec < 2 * fadeDurationSec`. Slider validators allow these configs (e.g., max=15/fade=10, max=10/fade=10). | Tighten PATCH validator to require `maxSongDurationSec >= 3 * fadeDurationSec`, OR make cooldown adaptive (`min(2*fadeMs, maxMs/3)`), OR replace wall-time cooldown with a `fadingFromUri` DB column. Add unit test covering ongoing track-to-track fades for max=15/fade=3 and max=15/fade=10. |
| high | `bluegrass-fade-transition/route.ts:113-120`, `fade-skip/route.ts:85-90` | `releaseCooldown` is best-effort; if its prisma.update throws, the cooldown stays at claim time and retries are silently dropped for 2·fadeMs. | Make the release a CAS (`updateMany WHERE lastSyncAdvance = $claimedAt`) so concurrent retries don't fight; log on failure. |
| medium | `fade-resume/route.ts:42-48`, `route.ts:147-154` | Reversed ease-out curve produces ease-in fade-in ("delayed swell"). | Add `buildFadeInCurve()` to `src/lib/fade-curve.ts`. (Carry-over from rounds 1+2.) |
| low | `BluegrassClient.tsx:317` | Cosmetic `>= 30` not updated to use `AUTO_DURATION_MIN_SEC`; UI says "(limit)" badge engages at 30 but auto-fade actually engages at 10. | Use `AUTO_DURATION_MIN_SEC` for symmetry. (Round 2 explicitly flagged.) |
| low | `fade-skip/route.ts:101`, `bluegrass-fade-transition/route.ts:179` | Stale comments don't mention the new `releaseCooldown` early-return mutation. | Update comments. |
| low | `fade-skip/route.ts` | User-facing Skip doesn't clear `stopAfterCurrent`; user might expect it. | Optional: clear the flag on manual skip. |
| low | `fade-skip` / `bluegrass-fade-transition` | 200 status on `concurrent_transition_in_flight`. | Use 409 for caller observability. (Carry-over.) |
| low | `fade-pause`, `fade-resume` | No cooldown guard on these endpoints. | Optional: same updateMany guard. (Carry-over.) |
| low | `public/sw.js:7` | Precache of `/bluegrass` may cache login redirect. | Drop from PRECACHE_URLS. (Carry-over from rounds 1 and 2.) |
| low | `socket-server.ts:18-22` | Health check lacks session counts. | Add `activeSessions.size`, etc. (Carry-over.) |

### Recommendation

**fix-and-resubmit**

The round-2 reviewer was wrong to declare the "high — first-fade silently dropped on tight configs" addressed. The fix to `play/route.ts:51` was necessary but not sufficient: the cooldown gate's invariant `lastSyncAdvance < now - 2*fadeMs` is fundamentally incompatible with the `decideSyncStatus` threshold of `progress >= maxMs` whenever `max < 2*fade`. The bug now manifests on every ongoing track-to-track auto-fade for tight configurations, not just the first. The schema default makes the first fade also vulnerable when setup time is short, but the ongoing-fade case is the harder blocker because *no* setup-time amount saves it.

Two clean paths forward:
1. Validate `maxSongDurationSec >= 3 * fadeDurationSec` at the PATCH endpoint and reject the silently-broken configurations explicitly. Update the slider min hints to match.
2. Replace the wall-time cooldown with a track-URI-based in-flight check: add `fadingFromUri String?` to `BluegrassSession`, set it in the atomic claim, clear it on success/release. The race that round 2 closed (client polling + socket reconnect double-fire) was about the *same* threshold of the *same* track — URI-keyed is the right primary key for that, not wall time.

Either fix is small. Pair with a unit test that walks two consecutive track-to-track fades for the spec V7 config (max=15, fade=3) AND a tight config (max=15, fade=10) to lock the invariant in.

The other round-2 fixes (cooldown release on failure, client-fallback gate import, stopAfterCurrent client-side parity) all landed correctly. Build clean, 21/21 tests green, branch is structurally healthy. One more focused patch should clear it.
