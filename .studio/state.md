# .studio/state.md

**Project:** PartyQueue (`crowddj` / `partyqueue.com`)
**Last updated:** 2026-04-28

> This file is the source of truth for "where is this project right now." New sessions read this first.

## Current Feature

- **Name:** Bluegrass DJ — PWA remote for PartyQueue's playback engine
- **Slug:** bluegrass-dj
- **Phase:** 2
- **Status:** signed-off
- **Spec:** `specs/bluegrass-dj/spec.md`
- **Branch:** not yet created (will be `feature/bluegrass-dj` worktree at `../bluegrass-dj` in Phase 3)

## Last Completed Step

2026-04-28: Phase 1 spec signed off by Jonathan. Vercel Pro upgrade prerequisite confirmed.

## Next Step

Phase 2: write `tasks.md` (every task has a verification criterion) and ADR `0001-bluegrass-session-model.md` (separate model vs `mode` field on Room). No code yet — Phase 3 (build) comes after Phase 2 outputs land.

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
