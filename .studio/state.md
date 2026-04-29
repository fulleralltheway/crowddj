# .studio/state.md

**Project:** PartyQueue (`crowddj` / `partyqueue.com`)
**Last updated:** 2026-04-29

> This file is the source of truth for "where is this project right now." New sessions read this first.

## Current Feature

- **Name:** none — between features

## Last Completed Step

2026-04-29: bluegrass-dj **shipped** to production (Phase 7). Merged `feature/bluegrass-dj` → `main` as commit `447685d` (`--no-ff` to preserve the 8 surgical commits). Vercel auto-deploy succeeded in 28s — proves Vercel Pro is active (Hobby would have rejected the 1-min cron). Fly.io socket server redeployed with the new `backgroundSessions` machinery; `/health` returns clean. Three production smoke checks pass: `/bluegrass` → 307 to `/login?callbackUrl=/bluegrass` (auth gate), `/bluegrass-manifest.webmanifest` → 200 with correct scope + theme, `/api/cron/sync-bluegrass` → 401 unauthenticated (security gate).

Spec status flipped draft → signed-off → shipped. ADR 0001 status flipped proposed → accepted.

## Next Step

Phase 6 QA on real hardware (V4–V11 + V14–V15 in `specs/bluegrass-dj/spec.md`) — needs Spotify Premium login + studio laptop with Spotify desktop + a phone. Hand-off list for Jonathan:

1. Add Abigail's Spotify account email to the Spotify Developer dashboard tester list (app is in Development mode).
2. On iPhone Safari at `https://www.partyqueue.com/bluegrass`, sign in and "Add to Home Screen" — verify standalone launch (V3).
3. Pick laptop as device + a playlist, press Play. Walk V4–V11.
4. The hard one: V8 — set max=15s/fade=3s, lock the phone, watch the laptop. Threshold-fade should fire on schedule via the socket server.
5. V14/V15 — repeat the threshold test with the socket server taken down (`flyctl scale count 0 -a crowddj-socket` in a test slot, or just block the websocket at the network layer); cooldown-guarded fade should still happen via Vercel Cron at up to 60s latency.

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
