# .studio/state.md

**Project:** PartyQueue (`crowddj` / `partyqueue.com`)
**Last updated:** 2026-04-29

> This file is the source of truth for "where is this project right now." New sessions read this first.

## Current Feature

- **Name:** Bluegrass Queue Management
- **Slug:** bluegrass-queue
- **Phase:** 3 (ready)
- **Status:** signed-off (Phase 2 outputs landed)
- **Spec:** `specs/bluegrass-queue/spec.md`
- **Tasks:** `specs/bluegrass-queue/tasks.md` (14 tasks, T0–T13)
- **Branch:** not yet created — first action of Phase 3 is `git worktree add ../bluegrass-queue -b feature/bluegrass-queue`

## Last Completed Step

2026-04-29: Phase 1 sign-off received from Jonathan. Phase 2 outputs landed — `tasks.md` (14 tasks T0-T13, every one with a falsifiable verification criterion) and ADR 0002 explaining why `BluegrassSessionTrack` is its own model rather than a reuse of `RoomSong`.

## Next Step

Phase 3 build, starting with T0 (worktree). When Vercel Pro upgrade and the Spotify Dev-mode rate limit are still relevant constraints — but neither blocks Phase 3 since the build doesn't need to hit playlist-metadata endpoints (search and `/me/player/*` are open).

## Active Sub-Agents

- none

## Blockers

- none

## Recent Decisions

- ADR 0001: `BluegrassSession` as a separate Prisma model (status: accepted) — 2026-04-28
- ADR 0002: `BluegrassSessionTrack` as a separate model from `RoomSong` (status: proposed; flips to accepted at Phase 5 review) — 2026-04-29

## Shipped Features (most recent 5)

| Date | Slug | Description |
|------|------|-------------|
| 2026-04-29 | bluegrass-dj | Phone-first installable PWA at /bluegrass — Spotify playback control with auto-fade at threshold, announcement-fade pause/resume, kill-switch End Session. Reuses PartyQueue's socket+cron transition pipeline via a parallel BluegrassSession model. |

---

## How to Use This File

**For new sessions:** Read this file first. If "Current Feature" is set, read `specs/<slug>/spec.md` and `specs/<slug>/tasks.md` next. Then resume from "Next Step."

**At every phase transition:** Update "Phase," "Last Completed Step," and "Next Step." Don't batch — update in the moment.

**At ship:** Move feature from "Current Feature" to "Shipped Features." Clear the active fields.
