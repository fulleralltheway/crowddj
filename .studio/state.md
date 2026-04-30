# .studio/state.md

**Project:** PartyQueue (`crowddj` / `partyqueue.com`)
**Last updated:** 2026-04-30

> This file is the source of truth for "where is this project right now." New sessions read this first.

## Current Feature

- **Name:** none — between features

## Last Completed Step

2026-04-30: bluegrass-ux-polish **shipped** to production. Merged `feature/bluegrass-ux-polish` → `main` as commit `6ec9a4e` with 5 surgical phase commits (b8348d8/0c1a6b3/bef2312/0b03d86/28dcae0). Tag `v5-bluegrass-ux-polish` pushed. Build clean, zero warnings. Phase 5 cold-context review came back SHIP, all 12 V-criteria pass-or-acceptable, no blockers. Round-2 UX polish over v4: auto-fade lifted out of Settings into Automation card, sheet headers given breathing room + drag-handle pill, Change Playlist sheet shows real playlists, header title "Bluegrass Ballroom" + stacked device/playlist rows, Settings button removed, phone-fit tightening so hero+transport+volume fits above iPhone 14 fold.

## Active Sub-Agents

- none

## Blockers

- none

## Recent Decisions

- ADR 0001: `BluegrassSession` as a separate Prisma model (status: accepted) — 2026-04-28
- ADR 0002: `BluegrassSessionTrack` as a separate model from `RoomSong` (status: accepted) — 2026-04-29

## Shipped Features (most recent 5)

| Date | Slug | Description |
|------|------|-------------|
| 2026-04-30 | bluegrass-ux-polish | Round-2 visual + structural polish on /bluegrass (commit `6ec9a4e`, tag `v5-bluegrass-ux-polish`). Surfaced auto-fade controls out of Settings into Automation card; rebuilt sheet headers with drag-handle pill + breathing room; Change Playlist sheet shows real playlists with search filter; title "Bluegrass Ballroom" + stacked device/playlist rows in header; Settings button removed; phone-fit tightening (hero+transport+volume above iPhone 14 fold). |
| 2026-04-29 | bluegrass-playback-fixes | Two playback bugs fixed: (1) music no longer stops after a song ends — advance paths use startPlaybackContext({uri}) instead of startPlayback([uri]) so the playlist context survives the explicit-track jump and Spotify auto-advances naturally. (2) "Stop after this song" no longer bleeds the tail — preloads the next track in a paused state so Resume plays cleanly from position 0. |
| 2026-04-29 | bluegrass-queue | DB-backed queue for Bluegrass DJ — see upcoming tracks, search Spotify, insert at "Play next" / "Add to end". Replaces per-skip /v1/playlists/{id}/tracks lookups with one-shot import + DB lookups, eliminating the rate-limit pressure that triggered the recent debug episode. (UI hidden in production per Jonathan; backend live.) |
| 2026-04-29 | bluegrass-dj | Phone-first installable PWA at /bluegrass — Spotify playback control with auto-fade at threshold, announcement-fade pause/resume, kill-switch End Session. Reuses PartyQueue's socket+cron transition pipeline via a parallel BluegrassSession model. |

---

## How to Use This File

**For new sessions:** Read this file first. If "Current Feature" is set, read `specs/<slug>/spec.md` and `specs/<slug>/tasks.md` next. Then resume from "Next Step."

**At every phase transition:** Update "Phase," "Last Completed Step," and "Next Step." Don't batch — update in the moment.

**At ship:** Move feature from "Current Feature" to "Shipped Features." Clear the active fields.
