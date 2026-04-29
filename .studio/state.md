# .studio/state.md

**Project:** PartyQueue (`crowddj` / `partyqueue.com`)
**Last updated:** 2026-04-28

> This file is the source of truth for "where is this project right now." New sessions read this first.

## Current Feature

- **Name:** Bluegrass DJ — PWA remote for PartyQueue's playback engine
- **Slug:** bluegrass-dj
- **Phase:** 3
- **Status:** in-progress
- **Spec:** `specs/bluegrass-dj/spec.md`
- **Tasks:** `specs/bluegrass-dj/tasks.md` (15 tasks, T0–T14)
- **Branch:** `feature/bluegrass-dj` worktree at `../bluegrass-dj` (T0 below)

## Last Completed Step

2026-04-28: Phase 2 outputs landed — `tasks.md` (15 tasks, every task has a verification criterion) + ADR `0001-bluegrass-session-model.md` (proposed) explaining why `BluegrassSession` is a separate model rather than a `mode` field on `Room`.

## Next Step

Phase 3 task T0: create the worktree (`git worktree add ../bluegrass-dj -b feature/bluegrass-dj`), then walk T1 → T14 in order, marking each `[done]` in `tasks.md` as its verification passes.

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
