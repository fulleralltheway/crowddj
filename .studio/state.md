# .studio/state.md

**Project:** PartyQueue (`crowddj` / `partyqueue.com`)
**Last updated:** 2026-04-29

> This file is the source of truth for "where is this project right now." New sessions read this first.

## Current Feature

- **Name:** Bluegrass Queue Management
- **Slug:** bluegrass-queue
- **Phase:** 1
- **Status:** draft
- **Spec:** `specs/bluegrass-queue/spec.md`
- **Branch:** not yet created (Phase 3 will create `feature/bluegrass-queue` worktree)

## Last Completed Step

2026-04-29: Phase 1 spec drafted at `specs/bluegrass-queue/spec.md`. Surfaced from a real need — the `/v1/playlists/{id}/tracks` rate-limit episode revealed that per-skip metadata fetches are architecturally fragile, and a DB-backed queue (PartyQueue's pattern) eliminates that pressure while also delivering the in-app queue management Abigail asked for (search + insert + see upcoming). Smell test passes; awaiting sign-off.

bluegrass-dj feature itself shipped earlier today and is in production (paste-URL workaround live in v42; full picker reactivates automatically once Spotify lifts the `/me/playlists` rate limit).

## Next Step

🛑 Sign-off gate. Send spec inline to Jonathan. After "go", advance to Phase 2 (tasks.md + ADR 0002 covering the `BluegrassSessionTrack`-vs-RoomSong decision).

## Active Sub-Agents

- none

## Blockers

- none

## Recent Decisions

- ADR 0001: `BluegrassSession` as a separate Prisma model (status: accepted) — 2026-04-28

## Shipped Features (most recent 5)

| Date | Slug | Description |
|------|------|-------------|
| 2026-04-29 | bluegrass-dj | Phone-first installable PWA at /bluegrass — Spotify playback control with auto-fade at threshold, announcement-fade pause/resume, kill-switch End Session. Reuses PartyQueue's socket+cron transition pipeline via a parallel BluegrassSession model. |

---

## How to Use This File

**For new sessions:** Read this file first. If "Current Feature" is set, read `specs/<slug>/spec.md` and `specs/<slug>/tasks.md` next. Then resume from "Next Step."

**At every phase transition:** Update "Phase," "Last Completed Step," and "Next Step." Don't batch — update in the moment.

**At ship:** Move feature from "Current Feature" to "Shipped Features." Clear the active fields.
