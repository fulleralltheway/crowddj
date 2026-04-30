---
name: Bluegrass Playback Bug Fixes
slug: bluegrass-playback-fixes
status: shipped
created: 2026-04-29
signed_off: 2026-04-29
shipped: 2026-04-29
---

# Bluegrass Playback Bug Fixes

> Two reproducible bugs in the Bluegrass DJ playback flow, plus a cold-context audit pass to catch any related defects before they ship. Compact spec — no schema changes, no new endpoints.

## 1. Outcomes

- [ ] **O1 (no-track-after-end):** When a track ends in playlist playback (skip OR threshold-fade OR Spotify's own auto-advance), Spotify continues playing the next track in the playlist context without needing user input. The now-playing card never goes blank for >2 seconds during a normal playlist.
- [ ] **O2 (clean stop-after-current resume):** With "Stop after this song" toggled, the threshold fires, fade-out completes, playback pauses, the now-playing card displays the **next** track (paused). Pressing Play resumes from track 2 cleanly with the configured fade-in — no tail of track 1 audible, no immediate fade-out, no double transition.
- [ ] **O3 (audit clean):** A cold-context reviewer reading the diff + spec finds no other instances of the same pattern bug (single-URI `startPlayback` that drops playlist context, or paused-on-stale-track behavior).

## 2. Scope Boundaries

### In Scope

- `src/app/api/bluegrass/sessions/[id]/fade-skip/route.ts`: replace the primary advance call from `startPlayback([nextUri], device)` to `startPlaybackContext(playlistUri, device, { uri: nextUri })`. Skip-to-next fallback (no DB queue) stays on Spotify's native `skipToNext`.
- `src/app/api/cron/bluegrass-fade-transition/route.ts`: same `startPlayback` → `startPlaybackContext` swap on the advance branch. Stop-after-current branch rewritten to preload the next track + pause (PartyQueue's room-pause pattern).
- Phase 5 cold-context review focused specifically on grepping for any other call site that uses `startPlayback(token, [singleUri], …)` in Bluegrass code paths, plus any pause-while-past-threshold pattern.

### Explicitly Out of Scope

- Schema changes — none needed.
- New endpoints — none needed.
- UI changes — none. The client polls `/state` and will reflect the now-loaded next track within ~2 seconds during the stop-after-current preload.
- Re-enabling the queue UI — that stays hidden per the prior decision.
- Changes to fade-pause / fade-resume — they correctly handle the "actual user pause for an announcement" case (no track preload there).
- Anything in `src/app/api/rooms/*` (PartyQueue) — out of scope.

## 3. Constraints

- **Technical:**
  - Reuse the existing `startPlaybackContext` helper in `src/lib/spotify.ts` — already accepts `{ uri?, position? }` offset. No lib changes.
  - Stop-after-current preload sequence must keep volume at 0 between the fade and the new-track pause so the user never hears the new track start. PartyQueue's `src/app/api/rooms/[code]/fade-skip/route.ts` (mode: "pause" branch) is the reference.
  - The cron-driven path's concurrency guard (`lastSyncAdvance` cooldown) and `releaseCooldown` logic stay intact — same release behavior on failure.
  - Build warnings = errors (per `~/Hub/.claude/rules/development.md`).
- **Time:** Compact fix; should ship in one pass.
- **Compliance / security:** No new external surface, no auth changes, no new tokens. Phase 5 review need not include `/security-review`.
- **Design / UX:** Behavior changes only — no visual changes.

## 4. Prior Decisions This Builds On

- ADR 0001 + 0002 stand: parallel pipelines, separate `BluegrassSession` and `BluegrassSessionTrack` models. This fix doesn't touch them.
- The DB-backed queue refactor (`getNextSessionTrack` returning the next unplayed/not-currently-playing row, `markCurrentPlayed` flipping isPlayed before lookup) shipped in commit `f04a2f6` is correct and unchanged here.
- The `startPlaybackContext` helper added in the original Bluegrass build (`51dee1e`) is the right Spotify API pattern for "play this specific track but keep the playlist context" and is what should always be used in Bluegrass advance paths.
- PartyQueue's `src/app/api/rooms/[code]/fade-skip/route.ts` mode:"pause" branch is the proven reference for "stop after this song with next track pre-loaded."

## 5. High-Level Tasks

1. **fade-skip swap:** in `src/app/api/bluegrass/sessions/[id]/fade-skip/route.ts`, replace the `startPlayback(token, [nextUri], device)` advance call with `startPlaybackContext(token, sess.playlistUri, device, { uri: nextUri })`. Update the response `source` field accordingly.
2. **fade-transition swap:** same change in `src/app/api/cron/bluegrass-fade-transition/route.ts` advance branch.
3. **fade-transition stopAfterCurrent rewrite:** rewrite the `if (sess.stopAfterCurrent)` branch to:
   - Fade is already complete and volume is at 0 by this point.
   - `pausePlayback` on the current (just-faded) track.
   - Look up next track via `getNextSessionTrack` (already done at the top of the function — reuse `nextRow`).
   - If `nextRow` exists: `setVolume(0)` (defensive), `startPlaybackContext(playlistUri, device, { uri: nextRow.spotifyUri })`, sleep ~300ms, `pausePlayback` again, `restoreVolume`. Track is now loaded + paused near position 0.
   - If `nextRow` is null (queue exhausted / not imported): fall back to current behavior (just pause + restoreVolume; user will hit Play and the existing /play route will restart playlist from top — acceptable end-of-playlist behavior).
   - Set `stopAfterCurrent: false` and `currentTrackUri` to the new track URI in the response.
4. **Cold-context review:** Phase 5 reviewer agent reads the diff + this spec + greps the codebase for similar patterns. Report goes to `.studio/reviews/bluegrass-playback-fixes.md`.

## 6. Verification Criteria

- [ ] **V1 (build):** `cd ~/spotifyapp && npm run build` clean, **zero warnings**.
- [ ] **V2 (manual smoke — auto-advance):** With max song duration = 0 (auto-fade off), play a playlist via Bluegrass DJ. When track 1 ends naturally, Spotify advances to track 2 within 1 second. Verified by listening + the /state poll showing the new track.
- [ ] **V3 (manual smoke — skip):** Press Skip mid-track. Track 2 plays. Let track 2 end naturally. Spotify advances to track 3.
- [ ] **V4 (manual smoke — threshold-fade):** With max song duration = 15s and fade duration = 3s, play through three transitions (track 1 → 2 → 3 → 4). All three transitions hit cleanly. Track 4 plays through to its natural end without stopping.
- [ ] **V5 (manual smoke — stop after this):** With max=15/fade=3, check "Stop after this song." Wait for threshold. Music fades to silence and pauses. The now-playing card updates within 2 seconds to show the next track. Press Play. The next track plays from the start with a smooth fade-in. No tail of the previous track audible.
- [ ] **V6 (cold-context review):** Phase 5 reviewer reports `Recommendation: ship` with zero block-severity issues. Specifically confirms (a) no remaining `startPlayback(token, [singleUri], …)` call sites in Bluegrass paths, (b) no other "pause while past threshold" patterns that would re-trigger fade on resume.

---

## Smell Test

- [x] Is every outcome observable from outside the system? **Yes — listen for music continuity (O1), listen for clean resume (O2), grep + structured review (O3).**
- [x] Could every verification criterion be falsified by a real test? **Yes — V1 is a build, V2-V5 are listenable, V6 is a structured review report.**
- [x] Is anything in "In Scope" vague? **No — three specific code locations and one review pass.**
- [x] Are there constraints I'm assuming but didn't write down? **The PartyQueue room-pause pattern as reference is called out explicitly. The "queue exhausted" fallback is called out.**
- [x] Could a stranger build this from this spec alone? **Yes — three named files, the swap pattern, the preload-and-pause sequence, and the reference implementation.**
- [x] Is anything in "Out of Scope" actually load-bearing? **No.**
