# .studio/state.md

**Project:** PartyQueue (`crowddj` / `partyqueue.com`)
**Last updated:** 2026-04-29

> This file is the source of truth for "where is this project right now." New sessions read this first.

## Current Feature

- **Name:** Bluegrass DJ — PWA remote for PartyQueue's playback engine
- **Slug:** bluegrass-dj
- **Phase:** 6 (pending — needs real-hardware QA)
- **Status:** review-complete
- **Spec:** `specs/bluegrass-dj/spec.md`
- **Tasks:** `specs/bluegrass-dj/tasks.md` (15/15 done)
- **Branch:** `feature/bluegrass-dj` (worktree at `../bluegrass-dj`); 8 commits ahead of `main`. Not yet pushed.

## Last Completed Step

2026-04-29: Phase 5 complete after three rounds of cold-context review at `.studio/reviews/bluegrass-dj.md`. Round 1 found 3 blockers + 4 fix-before-ship; Round 2 found 1 new blocker + 2 highs; Round 3 found 1 deep invariant violation. All addressed in commits `ccaa3aa`, `89e3d35`, `e24d050`. Build clean, 21/21 vitest tests green, ESLint clean. Carry-over nits (perceptual ease-in up-ramp, sw.js precaching auth-gated route, health-check session counts) explicitly deferred — flagged low-severity by all three reviewers.

8 commits on `feature/bluegrass-dj`:
- 9d2f629 schema (T1)
- 51dee1e API endpoints (T2–T5)
- c49732e cron + tests + vercel.json (T6–T9)
- f21edfc socket-server.ts extension (T10)
- 9119565 /bluegrass route + PWA shell + client UI (T11–T14)
- ccaa3aa Phase 5 round 1 fixes
- 89e3d35 Phase 5 round 2 fixes
- e24d050 Phase 5 round 3 fix (max >= 3*fade invariant)

## Next Step

Phase 6 (QA) — real-hardware testing per `Hub/development/skills/qa-testing.md` + spec V2-V11 (local) and V12-V15 (production). Requires a Spotify Premium account, the studio laptop with Spotify desktop app, and an iPhone (or any phone) for the PWA install test. **Cannot proceed autonomously.** Jonathan needs to confirm:
1. Vercel Pro upgrade complete on the `crowddj` project (otherwise Phase 7 deploy fails on the cron entry).
2. Bluegrass Spotify account is Premium.
3. Whether to deploy to production (Phase 7) before Phase 6 QA, or run Phase 6 against a Vercel preview URL first.

After QA passes, Phase 7 ships:
- `git push origin feature/bluegrass-dj:main` (or merge via PR if Jonathan prefers)
- `flyctl deploy --app crowddj-socket` to redeploy the socket server with the new sessions sync loop
- Visit `https://www.partyqueue.com/bluegrass` on iPhone Safari, install PWA, walk V12-V15
- Add Abigail's Spotify email to the Spotify Developer dashboard tester list

## Active Sub-Agents

- none

## Blockers

- none. Vercel Pro upgrade is the only prerequisite outside this repo and Jonathan is enabling it now (T8 verification will catch it if it isn't done before Phase 7).

## Recent Decisions

- ADR 0001: `BluegrassSession` lives as a separate model (status: proposed) — 2026-04-28

## Shipped Features (most recent 5)

| Date | Slug | Description |
|------|------|-------------|

---

## How to Use This File

**For new sessions:** Read this file first. If "Current Feature" is set, read `specs/<slug>/spec.md` and `specs/<slug>/tasks.md` next. Then resume from "Next Step."

**At every phase transition:** Update "Phase," "Last Completed Step," and "Next Step." Don't batch — update in the moment.

**At ship:** Move feature from "Current Feature" to "Shipped Features." Clear the active fields.

## Active Sub-Agents

- none

## Blockers

- none

## Recent Decisions

- (no ADRs yet — first one will be drafted in Phase 2: BluegrassSession-vs-Room schema decision)

## Shipped Features (most recent 5)

| Date | Slug | Description |
|------|------|-------------|

---

## How to Use This File

**For new sessions:** Read this file first. If "Current Feature" is set, read `specs/<slug>/spec.md` and `specs/<slug>/tasks.md` next. Then resume from "Next Step."

**At every phase transition:** Update "Phase," "Last Completed Step," and "Next Step." Don't batch — update in the moment.

**At ship:** Move feature from "Current Feature" to "Shipped Features." Clear the active fields.
