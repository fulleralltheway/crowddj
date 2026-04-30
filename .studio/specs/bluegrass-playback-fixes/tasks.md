# Bluegrass Playback Bug Fixes — Tasks

> Compact fix. 5 tasks. Every task has a verification criterion.

- [ ] **T0 — Worktree** — `git worktree add ../bluegrass-playback-fixes -b feature/bluegrass-playback-fixes`. Verify: branch shows feature/bluegrass-playback-fixes.

- [ ] **T1 — fade-skip: swap startPlayback → startPlaybackContext on advance**
  - Action: In `src/app/api/bluegrass/sessions/[id]/fade-skip/route.ts`, change the primary advance call from `await startPlayback(accessToken, [nextTrackUri], sess.deviceId ?? undefined)` to `await startPlaybackContext(accessToken, sess.playlistUri, sess.deviceId ?? undefined, { uri: nextTrackUri })`. Update import to swap `startPlayback` for `startPlaybackContext`. Skip-to-next fallback (the `else` branch when `nextRow` is null) keeps the existing `skipToNext` call.
  - Verification: `git diff` shows only the two-line import + one-line call swap. Build clean. Manual smoke: skip mid-track, let next track end naturally — Spotify advances.

- [ ] **T2 — fade-transition: same swap on advance branch**
  - Action: Same change in `src/app/api/cron/bluegrass-fade-transition/route.ts` advance branch (the `try { ... if (nextRow) startPlayback ... }` block).
  - Verification: Build clean. Threshold-fade transitions don't leave Spotify with a single-URI queue.

- [ ] **T3 — fade-transition: stopAfterCurrent rewrite (preload + pause)**
  - Action: Rewrite the `if (sess.stopAfterCurrent)` block in `src/app/api/cron/bluegrass-fade-transition/route.ts`. After the fade-down completes (volume already at 0), the block must:
    1. `pausePlayback` on the current track.
    2. Look up `nextRow` (already computed at the top of the function — reuse).
    3. If nextRow exists: short sleep, `setVolume(0)` defensively, `startPlaybackContext(playlistUri, device, { uri: nextRow.spotifyUri })`, sleep ~300ms (Spotify needs a moment), `pausePlayback` to lock the new track at near-position-0, `restoreVolume(targetVolume)`. Update DB: `currentTrackUri: nextRow.spotifyUri, trackStartedAt: new Date(), stopAfterCurrent: false`. Mark nextRow as isPlaying=true.
    4. If nextRow is null: keep current behavior — pause + restoreVolume + clear stopAfterCurrent. User pressing Play will hit /play and restart the playlist (acceptable end-of-playlist case).
  - Verification: V5 from spec — checking stopAfterCurrent + waiting for threshold + pressing Play results in track 2 starting cleanly with a fade-in, no tail audible.

- [ ] **T4 — Phase-4 verify gates** — `npm run build` zero warnings, `npm run test` 30/30 green, ESLint clean on the two changed files.

- [ ] **T5 — Phase-5 cold-context review**
  - Action: Spawn fresh general-purpose sub-agent. Brief includes the spec, the diff, and an explicit grep instruction to find any other `startPlayback(token, [singleUri], …)` call sites in Bluegrass paths and any other "pause while past threshold" patterns.
  - Verification: Reviewer outputs `Recommendation: ship` with zero block-severity issues. Report at `.studio/reviews/bluegrass-playback-fixes.md`.

## Phase-3 exit criteria

T0-T5 done with verifications passing → Phase 7 ship (merge to main).
