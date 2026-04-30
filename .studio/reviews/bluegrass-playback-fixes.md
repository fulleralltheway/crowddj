# Phase 5 Review — bluegrass-playback-fixes
**Reviewer:** cold-context general-purpose agent
**Date:** 2026-04-29
**Commits reviewed:**
- `d96126d` fix(playback): preserve playlist context on advance + preload on stop-after

## Intent match

**partial — the two `startPlayback` → `startPlaybackContext` swaps and the stopAfterCurrent rewrite are present and faithful to spec §5, but two pre-existing/adjacent issues bleed in: (a) one of the unit tests in `src/lib/bluegrass-queue.test.ts` is currently failing on `main` and on this branch (29/30 passing — V1 build is clean but Vitest is red, so the test gate is technically broken), and (b) the spec's stated fallback behaviour for the `nextRow == null` case ("user will hit Play and the existing /play route will restart playlist from top") does not match what the BluegrassClient actually does on resume, which is `fade-resume → resumePlayback`, not `/play` — so the documented graceful-degradation path is not the one the user actually gets.**

The two named files (`fade-skip/route.ts`, `bluegrass-fade-transition/route.ts`) are touched in exactly the ways §5 prescribes:

- `fade-skip/route.ts:107-117` — single-URI `startPlayback` swap → `startPlaybackContext(playlistUri, device, { uri: nextTrackUri })` ✓
- `bluegrass-fade-transition/route.ts:248-255` — same swap on the advance branch ✓
- `bluegrass-fade-transition/route.ts:185-227` — stopAfterCurrent branch rewritten with preload-and-pause ✓
- `bluegrass-fade-transition/route.ts:168` — `nextRow` lookup moved out of the `stopAfterCurrent ? null : …` ternary ✓
- `bluegrass-fade-transition/route.ts:213-220` — `stopAfterCurrent: false` + `currentTrackUri: nextRow.spotifyUri` + `trackStartedAt: new Date()` set on success ✓

Build is clean: `npm run build` produces zero warnings (V1 ✓). All targeted route changes match the verb-by-verb spec wording.

## Stage 1 findings

**No scope creep.** Only the two files named in spec §5 are touched. 12 insertions / 4 deletions in `fade-skip/route.ts`; 65 / 8 in `bluegrass-fade-transition/route.ts`. Nothing extra.

**Missing pieces:**

- **Spec §3 says "PartyQueue's `src/app/api/rooms/[code]/fade-skip/route.ts` (mode: 'pause' branch) is the reference."** The Bluegrass implementation **diverges from that reference** in two timing details (see Stage 2 / Medium below). Total Bluegrass preload window is ~700ms; PartyQueue reference is ~1300ms. Implementer used an aggressive timeline without justification.
- **Spec §6 V6 (cold-context review):** spec wants "no remaining `startPlayback(token, [singleUri], …)` call sites in Bluegrass paths." Audit pass complete — see below. **Bluegrass paths are clean.** PartyQueue paths still use `startPlayback([uri])` everywhere (out of scope per spec §2).
- **Verification gate:** Spec V1 says "build clean, zero warnings." Build is clean. But **`npm test` fails 1/30** on `src/lib/bluegrass-queue.test.ts:41` — the test asserts `findFirst` was called with `where: { sessionId, isPlayed: false }` but the helper now also passes `isPlaying: false`. This was introduced by commit `0746615` on `main` (NOT this branch), and fixed-in-name in the spec for the prior `bluegrass-queue` review, but the test fix never landed. Strictly out of scope for THIS spec, but the test gate is red and this branch ships into that red state.

## Stage 2 findings

### Critical

- **`src/app/api/cron/bluegrass-fade-transition/route.ts:194-199` — `startPlaybackContext` with `offset.uri = nextRow.spotifyUri` will 400 if `nextRow` is a manually-inserted track that is NOT in the playlist context.**

  The Bluegrass schema supports manual queue inserts via `src/app/api/bluegrass/sessions/[id]/queue/insert/route.ts:46-50` — any `spotify:track:*` URI passes the regex, and the search route returns arbitrary tracks (not constrained to the current playlist). Spotify's `PUT /v1/me/player/play` endpoint rejects `offset.uri` with **`400 Invalid track uri for given context`** when the URI is not a member of `context_uri`'s playlist. The `startPlaybackContext` helper at `src/lib/spotify.ts:142-146` re-throws that 400 with a generic message.

  Currently mitigated by Jonathan's note at `BluegrassClient.tsx:425` ("Queue UI is hidden in production right now") and by `import` not being wired into session start (`BluegrassClient.tsx:425-428`) — so the queue is empty in prod and `nextRow` is always `null`, hitting the `skipToNext` fallback. But:
  1. The moment the queue UI is re-enabled (the spec literally exists because it's about to be), this will fire.
  2. The same defect lives at `fade-skip/route.ts:112-117`.
  3. The wrapping `try`/`catch` at `bluegrass-fade-transition/route.ts:193-204` has a comment that says "fall through to the simple-pause behavior below" — but **execution does NOT actually fall through.** Lines 205-220 still execute (sleep, pause, restoreVolume, set isPlaying:true on `nextRow`, set `currentTrackUri = nextRow.spotifyUri`). The DB ends up claiming track 2 is loaded and playing when in fact nothing was loaded — Spotify is still on track 1 (paused). The session's audit trail is now wrong.

  Same for the advance branch at `fade-skip/route.ts:106-137` and `bluegrass-fade-transition/route.ts:246-267`: there the `catch` correctly returns 502, but the calling code (sync-bluegrass cron) has already set `currentTrackUri` to track 2 in some intermediate state because `markCurrentPlayed` flipped row 2 — wait, no, `currentTrackUri` is only written at line 277. So fade-skip/transition is OK on the advance branch (catch path is correct).

  **The stopAfterCurrent branch's `try { await startPlaybackContext(...) } catch { }` swallow-and-continue is the bug.** It pretends success and writes a "next track loaded" state to the DB even when the API call failed.

  Fix: in stopAfterCurrent, branch on whether `startPlaybackContext` actually succeeded. Skeleton:
  ```ts
  let preloaded = false;
  try {
    await startPlaybackContext(accessToken, sess.playlistUri, sess.deviceId ?? undefined, { uri: nextRow.spotifyUri });
    preloaded = true;
  } catch {}
  if (!preloaded) {
    // restore volume and bail to the no-nextRow path; do NOT update DB to claim track loaded
    await sleep(200);
    await restoreVolume(accessToken, sess.targetVolume);
    await prisma.bluegrassSession.update({ where: { id: sess.id }, data: { stopAfterCurrent: false } });
    return NextResponse.json({ ok: true, action: "stopped_after_song", fadedFrom: originalVolume, preloadFailed: true });
  }
  // ... rest of preload sequence
  ```

  Bonus: detect "track not in context" specifically (`startPlaybackContext` could throw a more specific error) and fall back to `startPlayback(accessToken, [nextRow.spotifyUri], ...)` for manually-inserted tracks. But that re-introduces the "single-URI queue" bug from the original spec, so keep it out of this patch — the right answer is to constrain manual inserts to playlist members, or to handle the single-URI case as "expected end of context-driven advance."

- **`src/app/api/bluegrass/sessions/[id]/fade-skip/route.ts:107-124` — same `offset.uri` defect for manually-inserted tracks, no defensive fallback.**

  The advance branch's `try { startPlaybackContext } catch (e) { return 502 "skip_failed" }` is the right shape, BUT the user-pressed-Skip flow goes through THIS endpoint, and the 502 surfaces to the client as a generic error. After Skip on a manually-inserted track, Spotify is still on the previous track at volume 0. The client's `handleSkip` (BluegrassClient.tsx:448-452) doesn't surface the 502 visibly and just `void pollState()`s — the user sees the now-playing card freeze and silence. There's no automated retry to `startPlayback([nextRow.spotifyUri])` (the safe fallback for non-context tracks).

  Fix: when `startPlaybackContext` throws, attempt `startPlayback(accessToken, [nextRow.spotifyUri], sess.deviceId ?? undefined)` as a single-URI fallback before giving up. Yes, this re-introduces the "Spotify won't auto-advance after this single track ends" issue, but at least the user gets the skip they asked for. The cron's threshold detection will fire fade-transition again at the next maxSongDurationSec boundary, advancing to track 3 (which IS in the playlist) and re-establishing context.

### High

- **`src/app/api/cron/bluegrass-fade-transition/route.ts:185-227` — preload sequence is ~600ms shorter than the PartyQueue reference, increasing the audible-track race window.**

  PartyQueue reference (`src/app/api/rooms/[code]/fade-skip/route.ts:115-123`):
  ```
  pausePlayback → sleep(500) → setVolume(0) → sleep(200) → startPlayback → sleep(300) → pausePlayback → sleep(300) → restoreVolume
  ```
  Total wall time between fade end and restoreVolume: ~1300ms.

  Bluegrass implementation (`bluegrass-fade-transition/route.ts:186-208`):
  ```
  pausePlayback → sleep(200) → setVolume(0) → startPlaybackContext → sleep(300) → pausePlayback → sleep(200) → restoreVolume
  ```
  Total: ~700ms.

  Two specific divergences:
  1. **Missing 500ms rate-limit cooldown after the fade loop.** The fade just issued `multipliers.length` (~30) `setVolume` calls in `fadeDurationMs` (e.g. 3000ms). PartyQueue's 500ms cooldown is there to avoid 429s. Bluegrass skips it.
  2. **200ms instead of 300ms before `restoreVolume`.** This is the window where the just-paused next track might still be propagating through Spotify Connect — if the pause hasn't landed at the device when restoreVolume cranks volume back up, the user hears mid-track audio for the duration of the propagation latency.

  Likelihood: both small. Combined with restoreVolume's own retry loop (`bluegrass-fade-transition/route.ts:20-32`), the volume-up could happen before the device pause has taken effect. PartyQueue's longer settle has shipped to Lexington-area weddings without complaints; the Bluegrass version is unproven and shorter.

  Fix: match the PartyQueue timing exactly. Insert `await sleep(500)` after the fade loop's final `setVolume(0)` (line 178), and bump the post-pause sleep at line 207 from 200 to 300. Free correctness, costs 600ms of silence the user wouldn't notice anyway (they're between songs).

- **`src/app/api/cron/bluegrass-fade-transition/route.ts:200-204` — error swallow on preload `startPlaybackContext` does not actually fall through.** (See Critical-1 above.) The comment claims "fall through to the simple-pause behavior below" but lines 205-220 unconditionally execute the rest of the preload-success path: sleep, pausePlayback (of nothing new), restoreVolume, mark `nextRow` as `isPlaying: true`, set `currentTrackUri = nextRow.spotifyUri`. Spotify is still on track 1 (paused) but the DB now says track 2 is loaded and playing. The next sync tick reads `currentTrackUri = track2`, polls Spotify, sees `item.uri = track1`, and — depending on whether the race-safety check at line 95 fires for `expectedTrackUri = track1` — either bails or fires another fade for "track 2", leading to stale-track behavior. This is the audit-trail divergence I called out in Critical-1.

- **Spec §5 task 3 says: "If `nextRow` is null (queue exhausted / not imported): fall back to current behavior (just pause + restoreVolume; user will hit Play and the existing /play route will restart playlist from top — acceptable end-of-playlist behavior)."** The implementation does that. But **the BluegrassClient does NOT route to `/play` on resume.**

  `BluegrassClient.tsx:431-446` reads:
  ```
  if (playback?.isPlaying) → fade-pause
  else if (!hasStarted)    → /play
  else                     → fade-resume
  ```
  After the very first `/play` succeeds (line 440 sets `setStartedForSession(sess.id)`), every subsequent press of Play goes to `fade-resume`, NOT `/play`. So when the spec says "user hits Play → /play → playlist top", that doesn't happen. The user's actual experience in the `nextRow == null` fallback:
  1. Track 1 fades to silence + pause. (good)
  2. User hits Play → `fade-resume` → `resumePlayback` (Spotify resumes whatever is loaded). Whatever is loaded is the SAME just-faded track 1 at `progress_ms` past `maxSongDurationSec`. (bad)
  3. Next sync tick fires, sees `progress >= maxMs`, returns `needs_fade`. Fade-transition fires AGAIN. This time `stopAfterCurrent` is already false (cleared at line 234 on the prior fire), so the advance branch runs. Track 2 plays. (eventually correct, but with a second fade the user did not ask for)

  This is the OLD bug the spec was supposed to fix (V5: "No tail of the previous track audible"). In the queue-imported case (Critical-1 fixed), the preload path handles it. In the queue-empty case, **the spec's claimed fallback isn't real**. Either:
  - Update `handlePlayPause` to detect "track has ended / past threshold" and call `/play` to reset (requires reading playback state in the client), OR
  - Have the fallback path at `bluegrass-fade-transition/route.ts:230-236` ALSO call `setStartedForSession(null)` somehow (it can't — server-side) OR set a session field the client reads to know to re-`/play`, OR
  - Accept the documented degraded path: this only fires when the queue isn't imported, which is also the only state Bluegrass currently ships in. Production users WILL hit this because the queue UI is hidden.

  My recommendation: at minimum, document the divergence in the spec or add a server-side flag (e.g., `needsFreshPlay: true` on the session) the client can read to call `/play` instead of `fade-resume` on the next play press.

- **`src/app/api/cron/bluegrass-fade-transition/route.ts:209-220` — DB writes happen after best-effort `pausePlayback` and `restoreVolume`. If any of those throw, the writes still execute, but `await prisma.bluegrassSession.update` could itself fail and leave the system in a half-state.**

  All three Spotify ops are `try {} catch {}`-wrapped. The Prisma updates are NOT. If the preload's `startPlaybackContext` succeeded but the subsequent `bluegrassSession.update` fails (Postgres timeout, connection drop), `stopAfterCurrent` stays `true`, `lastSyncAdvance` was already updated to `now`, and the next sync tick will see `stopAfterCurrent: true` again, hit threshold detection (because Spotify is paused — actually no, `decideSyncStatus` returns `playing` for paused state at `bluegrass-sync.ts:79-81`), and... do nothing for now. The user hits Play → `fade-resume` → next track plays from position 0 (correct). But `stopAfterCurrent` is still true in DB. Next time the user presses "Stop after this song" toggle, the toggle becomes a no-op (already true), and the user is confused.

  Lower severity than it sounds because the failure window is narrow, but worth noting. Wrap the two DB updates in a `try/catch` that releases the cooldown on failure (matching the rest of the file's pattern at lines 263-267).

### Medium

- **`src/app/api/cron/bluegrass-fade-transition/route.ts:218 + 277` — `trackStartedAt: new Date()` is written on preload, but the user hasn't pressed Play yet.** Implementer concern in the review brief flagged this. **NOT actually a bug** — `trackStartedAt` is documented as "audit trail only" (`sync-bluegrass/route.ts:132-134`); threshold detection uses `playback.progress_ms` from Spotify (`bluegrass-sync.ts:93-95`), which doesn't tick while paused. So even if the user takes a 2-minute announcement before pressing Play, the next threshold fire happens at `progress_ms >= maxMs` measured from the resumed playback, not from `trackStartedAt`. Confirmed by reading every consumer of `trackStartedAt` in the codebase: only writers, no readers in the threshold-fire path. Safe.

  But: `trackStartedAt` IS used to populate the `BluegrassSession` GET response (line 33 of `[id]/route.ts` returns the raw row), and any downstream consumer reading `now - trackStartedAt` as "elapsed time on track" would be off by however long the user's announcement was. No such consumer exists today; documenting in case one is added.

- **`src/app/api/cron/bluegrass-fade-transition/route.ts:205-208` — `await sleep(300); pausePlayback; await sleep(200); restoreVolume` race.** If `startPlaybackContext`'s play command lands at the device during the 300ms sleep (typical: 100-300ms for Spotify Connect to propagate to a real device), the pause command issued at line 206 may land BEFORE the play command propagates. Spotify processes commands roughly in send order, so this is rare, but in practice on slow Wi-Fi the pause can fire to a state where Spotify hasn't yet started the new track, leading to "pause when nothing is playing" no-op. Then play arrives, track starts at volume 0 (silent — `setVolume(0)` was set at line 192). 200ms later restoreVolume fires → user hears the track playing audibly mid-song. Same root cause as the timing-divergence concern in High-1.

  Fix is the same: match PartyQueue's longer sleeps. With sleep(300) → sleep(500) before restoreVolume and the pre-fade 500ms cooldown, this race shrinks to <1% probability.

- **`src/app/api/cron/bluegrass-fade-transition/route.ts:165-167` — comment is slightly wrong.** "Look up next track regardless of stopAfterCurrent — the stop-after path also needs it (preloads the new track + pauses, so resume plays the next song cleanly from position 0 instead of replaying the tail of the previous one)." Correct as written, but it's worth adding "if the queue is empty (`nextRow == null`), fall back to simple pause; user-resume from `fade-resume` will replay the previous track's tail and re-trip the threshold (existing behavior, see High-3)." Without that, future readers will assume the bug is fixed in all paths.

- **Race-safety check at `bluegrass-fade-transition/route.ts:95` works correctly with the new path,** but I want to call out the analysis: after the stopAfterCurrent preload, `currentTrackUri` is set to `nextRow.spotifyUri` (track 2). If a stale fade-transition call arrives later with `expectedTrackUri = track1`, the check `sess.currentTrackUri (track2) !== body.expectedTrackUri (track1)` → bails with `track_already_changed`. This is the right behavior — the call IS stale. **Not a bug**, but the analysis should be in the file's comments so a future maintainer doesn't "fix" the check.

### Low / nits

- **`src/app/api/bluegrass/sessions/[id]/fade-skip/route.ts:111` and `:97-104`** — the comment block at lines 97-104 says `1. DB queue → startPlayback with explicit URI (ideal)` but the code now uses `startPlaybackContext`. Stale comment from the pre-patch state. Update to `startPlaybackContext with explicit URI offset`.

- **`src/app/api/cron/bluegrass-fade-transition/route.ts:163-167`** — the new comment block partially overrides the prior comment ("Skipped for stopAfterCurrent since we pause"). The two comments contradict each other (one says skipped, the next says always look up). Delete the old comment, keep only the new one.

- **`src/app/api/cron/bluegrass-fade-transition/route.ts:188-190`** — comment says "Preload next: vol stays at 0 (already faded), start the next track, give Spotify a beat, pause it at near-position-0, then restore target volume so a Resume picks up at full level." But the code at line 192 explicitly does `setVolume(0)` defensively, so "vol stays at 0" is half-misleading — we re-assert it. Minor.

- **`src/app/api/cron/bluegrass-fade-transition/route.ts:223`** — response action `"stopped_after_song_preloaded"` vs the existing `"stopped_after_song"` for the no-queue fallback. Two different action names for what is conceptually one operation, distinguished by an outcome flag. Cleaner: use one action name with a `preloadedNext: true | false` field.

- **`src/app/api/cron/bluegrass-fade-transition/route.ts:185`** — comment says "preload the next track in a paused state so when the user resumes it plays cleanly from position 0." Spotify does NOT guarantee position 0 from `startPlaybackContext` with `offset.uri` — it plays from wherever Spotify's saved cursor for that context is, which COULD be the URI's beginning if the URI hasn't been played in this session, or could be wherever Spotify last left off. To guarantee position 0, pass `position: 0` in the offset (cf. `play/route.ts:38` which passes `{ position: 0 }`). Not a bug in practice (Spotify does start at 0 for a fresh `offset.uri`), but the comment overstates the contract.

- **`src/app/api/bluegrass/sessions/[id]/fade-skip/route.ts:106` and `:153`** — response field `source: nextRow ? "db_queue" : "spotify_native_skip"`. Spec §5 task 1 says "Update the response `source` field accordingly." It WAS already returning this value in the prior patch; the new code doesn't change the field. ✓ No-op against the spec's wording, but consistent with reality.

- **No new tests.** Spec doesn't require unit tests for route handlers (they're DB+Spotify-glued; per Round-1 of the prior review, those aren't testable as pure logic). But the existing `bluegrass-queue.test.ts:41` failure (pre-existing) means the test suite is red regardless. If/when it's fixed, an integration test for the stopAfterCurrent preload path would be valuable: mock `startPlaybackContext` to throw, assert the DB does NOT get updated to claim `nextRow.isPlaying = true`. That regression test would have caught Critical-1.

- **`src/app/api/cron/bluegrass-fade-transition/route.ts:240-244`** — the new comment says "fixes the 'music stops after song' bug that startPlayback(uris:[X]) caused" — accurate diagnosis, good context for future readers. Keep.

- **`src/app/api/cron/bluegrass-fade-transition/route.ts:176`** — comment block change preserves all prior context except inserts the new block. Diff is clean. ✓

## Audit pass (per spec O3)

### Other `startPlayback(token, [singleUri], …)` call sites in Bluegrass paths

**Clean.** `grep -rn "startPlayback(" src/ --include='*.ts'` shows zero remaining call sites of `startPlayback(...)` in any Bluegrass path. All instances are in PartyQueue (`src/app/api/rooms/[code]/...`, `src/app/api/cron/sync-rooms`, `src/app/api/cron/fade-transition`), which is explicitly out of scope per spec §2.

Specifically verified:
- `src/app/api/bluegrass/sessions/[id]/fade-skip/route.ts:1-7` — only imports `startPlaybackContext`, not `startPlayback` ✓
- `src/app/api/cron/bluegrass-fade-transition/route.ts:1-5` — same ✓
- `src/app/api/bluegrass/sessions/[id]/play/route.ts:1-3` — only `startPlaybackContext` ✓
- `src/app/api/bluegrass/sessions/[id]/fade-pause/route.ts` — no playback start, only pause ✓
- `src/app/api/bluegrass/sessions/[id]/fade-resume/route.ts` — uses `resumePlayback` (no URIs) ✓
- `src/app/api/cron/sync-bluegrass/route.ts` — no playback start at all (forwards to fade-transition) ✓

**O3 audit pass: clean for Bluegrass.**

### Other "pause while past threshold" patterns

**Clean.** `grep -rn "pausePlayback" src/app/api/bluegrass src/app/api/cron --include='*.ts'`:
- `src/app/api/bluegrass/sessions/[id]/route.ts:175` — DELETE handler pause, expected (kill switch).
- `src/app/api/bluegrass/sessions/[id]/fade-pause/route.ts:44, 53` — explicit user-pause endpoint, NOT a threshold path. The comment in `bluegrass-sync.ts:76-81` confirms paused state is treated as "not eligible for threshold-fade." User-pause does NOT preload-next, which is correct per spec §2 ("Out of Scope: Changes to fade-pause / fade-resume — they correctly handle the 'actual user pause for an announcement' case (no track preload there)."). ✓
- `src/app/api/cron/bluegrass-fade-transition/route.ts:186, 206` — both inside the stopAfterCurrent branch, which is the focus of this fix. No additional threshold-pause sites. ✓

**O3 audit pass: clean for Bluegrass.**

## Tests

`npm test` → **29 / 30 passing**. The single failure (`src/lib/bluegrass-queue.test.ts:41`) was introduced by `0746615` on `main` and is NOT this branch's regression. The test asserts:
```
expect(mockTrack.findFirst).toHaveBeenCalledWith({ where: { sessionId, isPlayed: false }, orderBy: { sortOrder: "asc" } })
```
but the helper now passes `where: { sessionId, isPlayed: false, isPlaying: false }`. Fix: update the assertion. Out of scope for this spec, but should be cleaned up either before this branch merges OR as a follow-up commit immediately after.

`npm run build` → **clean, zero warnings.** ✓ V1 passes.

## Unresolved issues

| Severity | Location | Issue | Suggested fix |
|---|---|---|---|
| **Critical** | `bluegrass-fade-transition/route.ts:200-204` | `startPlaybackContext` swallow-and-continue: if the preload throws (e.g., manually-inserted track not in playlist context, or device disappeared), execution falls through and writes "track 2 loaded" to DB while Spotify is still on track 1. Audit trail diverges from reality. | Branch on whether the preload succeeded. On failure, run the simple-pause-only path and return early; do NOT update `currentTrackUri` or `nextRow.isPlaying`. |
| **Critical** | `fade-skip/route.ts:107-117` and `bluegrass-fade-transition/route.ts:248-255` | Same defect for advance branch with manually-inserted tracks not in playlist context — but here the catch path does return 502, so DB is consistent. The user-facing failure mode is "Skip silently does nothing" with no automated retry. | On `startPlaybackContext` throw, attempt `startPlayback(accessToken, [nextRow.spotifyUri], sess.deviceId ?? undefined)` as a single-URI fallback before giving up. Document that this is the "manually-inserted track" recovery path and Spotify won't auto-advance after — a subsequent threshold or user skip will re-establish playlist context. |
| **High** | `bluegrass-fade-transition/route.ts:185-208` | Preload sequence is ~600ms shorter than PartyQueue reference; missing the post-fade 500ms rate-limit cooldown and shortened settle-before-restore-volume. Increases probability of audible-track race. | Match PartyQueue exactly: `await sleep(500)` after the fade loop's final `setVolume(0)`, and bump line 207's `sleep(200)` → `sleep(300)`. |
| **High** | Spec §5 task 3 + `BluegrassClient.tsx:431-446` | Spec's claimed fallback ("user hits Play → `/play` → playlist top") doesn't match client behavior (`fade-resume → resumePlayback`, which replays the just-faded track past threshold and re-trips the fade). | Either (a) update the spec to document the actual degraded path, or (b) wire a `needsFreshPlay` flag through the session row and have `BluegrassClient.handlePlayPause` route to `/play` instead of `fade-resume` when that flag is true, then have the fallback path set it. |
| **High** | `bluegrass-fade-transition/route.ts:209-220` | DB writes after the preload-success path are not wrapped in try/catch and don't release the cooldown if Postgres fails. Half-states possible. | Wrap the two `prisma.*.update` calls in a try/catch that releases the cooldown (mirror lines 263-267). |
| **Medium** | `bluegrass-fade-transition/route.ts:194-199` | `startPlaybackContext(playlistUri, deviceId, { uri: nextUri })` does not pass `position: 0`. Spotify almost always starts a fresh `offset.uri` at 0, but the contract isn't guaranteed. | Pass `{ uri: nextRow.spotifyUri, position: 0 }`. Same change at `fade-skip/route.ts:117`. |
| **Medium** | `bluegrass-fade-transition/route.ts:163-167` and `:185-190` | Comments contradict each other across the diff hunks (one says "skipped for stopAfterCurrent", the next says "look up regardless"). Stale comment from prior implementation. | Delete the prior "skipped for stopAfterCurrent" half of the comment; keep only the new wording. |
| **Low** | `fade-skip/route.ts:97-104` | Stale comment "DB queue → startPlayback with explicit URI" — code now uses `startPlaybackContext`. | Update to "DB queue → `startPlaybackContext` with explicit URI offset (keeps the playlist as queue context)". |
| **Low** | `bluegrass-fade-transition/route.ts:223 + 236` | Two response action names (`"stopped_after_song_preloaded"` vs `"stopped_after_song"`) for what is conceptually one operation. | Use a single action name with `preloadedNext: true | false`. Won't break clients (no client reads the action field). |
| **Low** | `bluegrass-fade-transition/route.ts:188-190` | Comment overstates: says "vol stays at 0" but the code re-asserts `setVolume(0)` defensively. | Reword: "vol is at 0 from the fade; defensively re-assert to handle race where the volume was bounced higher mid-fade." |
| **nit** | `bluegrass-queue.test.ts:41` | Pre-existing test failure introduced by `0746615` on `main` — assertion missing `isPlaying: false`. Test gate is red on `main` and on this branch. | Update assertion to include `isPlaying: false`. Not blocking this spec but should be a follow-up commit before any further work merges. |

## Recommendation

**fix-and-resubmit**

Two Critical-tier issues:

1. **The stopAfterCurrent preload's `try { startPlaybackContext } catch {}` swallow-and-continue** writes a stale "next track loaded" state to the DB when the preload fails. Currently masked because the queue UI is hidden in production (and so `nextRow` is always null in prod, taking the safe fallback), but this is THE feature the spec exists to gate-keep before the queue UI re-enables. Ship as-is and the first time someone manually inserts a non-playlist track, the DB and Spotify diverge silently.

2. **`startPlaybackContext` with `offset.uri` rejects URIs not in the playlist context (HTTP 400).** Manual queue inserts via `queue/insert/route.ts` accept arbitrary `spotify:track:*` URIs (no playlist-membership check). Both the advance branch and the stopAfterCurrent preload will fail for any such track. The advance branch returns 502 (visible to user as silent skip-failure); the stopAfterCurrent preload silently corrupts the audit trail.

Plus three High-tier items that are fix-now-or-fight-them-in-prod:

- Preload timing diverges from PartyQueue reference (Bluegrass is 700ms total vs reference 1300ms) — increases audible-track race probability.
- Spec §5's `nextRow == null` fallback ("user hits Play → /play → playlist top") doesn't match the client's actual `fade-resume` path. The user STILL gets a tail-bleed-into-second-fade in the queue-empty case, which is the only case shipping right now.
- DB updates aren't error-wrapped after the preload, so a Postgres timeout leaves `stopAfterCurrent: true` orphaned.

The intent and the swap are right. The execution leaves audit-trail and timing risks that the PartyQueue reference (which the spec explicitly requires matching) handles. Bring the timing into parity, harden the preload error path, and reconcile the spec's fallback claim with the client's behavior — then this is a `ship`. Today it's not.

The audit pass for spec §2/§5/O3 ("no other `startPlayback(token, [singleUri], …)` in Bluegrass paths" + "no other pause-while-past-threshold patterns") is **clean**. That part of the work is done.
