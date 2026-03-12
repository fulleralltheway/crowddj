# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PartyQueue — a crowd-sourced DJ app where hosts connect Spotify, create rooms from playlists, and guests vote on songs via mobile/PWA. The queue reorders by net votes in real-time.

## Commands

```bash
npm run dev              # Next.js dev server (port 3000)
npm run dev:socket       # Socket.io server (port 3001)
npm run dev:all          # Both servers concurrently
npm run build            # prisma generate && next build
npm run lint             # ESLint
npx vercel --prod        # Deploy to Vercel production
flyctl deploy --app crowddj-socket  # Deploy socket server to Fly.io
```

### Database

```bash
npx prisma generate      # Regenerate Prisma client (output: src/generated/prisma)
npx prisma studio        # Open Prisma Studio GUI
```

Schema changes: Pull production env, then push:
```bash
vercel env pull .env.production.local --environment production
DATABASE_URL=$(grep '^DATABASE_URL=' .env.production.local | sed 's/^DATABASE_URL="//' | sed 's/"$//') npx prisma db push
rm .env.production.local  # Clean up secrets
```

## Architecture

### Tech Stack
- **Next.js 16** (App Router) + TypeScript + **Tailwind CSS v4** (`@theme inline` for custom vars)
- **Prisma 7** with PostgreSQL via `@prisma/adapter-neon` (Neon Postgres)
- **NextAuth v5 beta** with custom Prisma adapter (`src/lib/prisma-adapter.ts`)
- **Socket.io** for real-time updates (separate server on Fly.io, not Vercel-compatible)
- **FingerprintJS** for device-based guest identity (anti-abuse)

### Prisma 7 Specifics
- Adapter pattern required: `new PrismaClient({ adapter })` — no zero-arg constructor
- Import from `@/generated/prisma/client` (not `@/generated/prisma`)
- Adapter class is `PrismaNeon` from `@prisma/adapter-neon`, takes `{ connectionString }`
- `prisma.config.ts` lives at project root (not in `prisma/` dir)
- Schema datasource has no `url` field (moved to prisma.config.ts)

### Three-Part Runtime Architecture

1. **Next.js on Vercel** — UI + API routes. All API endpoints under `src/app/api/rooms/[code]/`. The `auth()` call in API routes provides session with `(session as any).accessToken` for Spotify API calls.

2. **Socket.io on Fly.io** (`socket-server.ts`, `Dockerfile.socket`) — Real-time event relay + background sync loop. Runs a 5-second interval calling the Vercel cron endpoint, then broadcasts song/room updates to connected clients. **Keeps syncing rooms even after all clients disconnect** (`backgroundRooms` set) so playback continues when everyone closes the app. Rooms are removed from background tracking when explicitly closed or when the cron reports them as inactive/expired. Key events: `songs-update`, `room-update`, `vote-update`, `songs-reordered`, `song-requested`, `room-settings-changed`.

3. **Spotify Web API** (`src/lib/spotify.ts`) — Playback control, search, playlist import. Always uses `startPlayback` with explicit URI for transitions (never `skipToNext` or `addToQueue` which are unreliable). Token refresh happens in `auth.ts` (session callback), `cron/sync-rooms` (direct refresh from Account table), and `cron/fade-transition` (server-side fades).

### Song Transition System

Three layers handle transitions, with automatic fallback:

1. **Client-side (DashboardClient.tsx)** — When owner's app is open: auto-transition timer fires at `maxSongDurationSec`, calls `fadeSkipSong` which uses the `/api/rooms/[code]/fade-skip` endpoint. Pre-queues (locks) the next song 15s before threshold. Uses `playbackBusy` ref as mutex to prevent concurrent API calls and `autoTransitionFired` ref to prevent double-fires.

2. **Socket server (socket-server.ts)** — When owner closes app: sync loop passes `deferFade=true` to cron. When cron returns `needs_fade`, socket server calls `/api/cron/fade-transition` which reads the host's Spotify token from the Account table and runs the full fade loop server-side.

3. **Cron hard skip (sync-rooms)** — Last resort when socket server isn't available: cron does a hard `startPlayback` skip (no fade) when `deferFade` is not set.

### Song Lifecycle & Queue Management
- Songs are imported from a Spotify playlist into `RoomSong` rows with `sortOrder`
- Guests vote; the reorder algorithm (`src/lib/reorder.ts`) sorts unplayed songs by net score
- `getNextSong()` in `src/lib/queue.ts` — **shared helper** used by ALL playback routes to determine next song, matching exact display order. Returns `lastPreQueuedId` song first if set, then uses pinned/locked/unlocked merge logic
- At ~15s before threshold, the next song is locked (`isLocked = true`, `lastPreQueuedId` set) so UI shows "Queued Next". The `lastPreQueuedId` song is always forced to position 0 in both display and playback order
- **Manual DJ lock** (`isLocked && lastPreQueuedId !== song.id`): owner override, hides votes, yellow highlight
- **Auto-queue lock** (`isLocked && lastPreQueuedId === song.id`): cron/client-triggered, shows votes dimmed, accent highlight with "Up Next"/"Queued Next" label
- `lastSyncAdvance` timestamp debounces transitions — prevents cron from racing with client-side fades
- **DJ position lock** (dropdown "lock at #X" and drag-and-drop) both use the same two-step path: `/reorder` (sets explicit sortOrders from the display order) then `/lock` with `forceLock: true` (simple lock, no `isPinned`). The lock endpoint also has a legacy position-based path using `isPinned`/`pinnedPosition` — the songs API, `getNextSong`, and `reorderByVotes` still support it via three-way merge, but the UI no longer uses it
- `shiftPinnedPositions()` in `queue.ts` decrements all pinned positions by 1 on every song transition — called from all transition paths (skip, fade-skip, fade-transition, sync-rooms)

### Vote System & Guest Stats
- Votes are individual records (`Vote` table) with `value: 1` (upvote) or `-1` (downvote)
- **Reclaim**: voting opposite direction deletes the existing vote (refunds it) — does NOT create a new vote. Upvote→downvote = neutral, not both
- `Guest.totalUpvotes`/`totalDownvotes` are **lifetime counters** that accumulate at **vote reset time only** (not on each vote). Before votes are bulk-deleted on reset, current counts are added to these fields
- Guest stats display: `totalUpvotes + currentUpvotes.length` = past resets + current period (no double-counting)

### Fade-out Volume Control
- `buildFadeCurve()` generates smooth ease-out curve (power curve 1.8): 4 steps/sec for fades ≤3s, 2 steps/sec for longer fades, max 24 total steps (avoids Spotify API rate limits)
- Each `setVolume` step wrapped in individual try/catch — one Spotify API error doesn't abort the fade
- `fadeDurationSec` stored on Room model — syncs to DB when owner changes it, read by server-side fade endpoint
- Emergency recovery: catch block pauses playback and restores volume
- Vercel endpoints that run fades need `export const maxDuration = 60` (default 10s timeout kills mid-fade)

### External Song Recovery
When Spotify plays a song not in the queue (user changed song via Spotify app, autoplay, etc.):
1. Cron checks if the playing song matches any unplayed song in the room → syncs DB to match
2. If `maxSongDurationSec` is active and off-queue for 30s+ → force-starts the correct queue song
3. Otherwise reports `"external"` and leaves Spotify alone

### Spotify iFrame Embed API (Preview Playback)
- Only has `togglePlay()` — NO separate `play()` or `pause()` methods
- `addListener("ready")` and `addListener("playback_update")` are unreliable and can interfere with playback
- The only working pattern: `setTimeout(500)` + `controller.togglePlay()`. Do NOT add event listeners that trigger additional `togglePlay()` calls — double-toggling causes play→immediate pause
- `playback_update` is safe ONLY for end detection (detecting when preview clip finishes), wrapped in try/catch
- When switching between previews, reuse the existing controller via `controller.loadUri(newUri)` + `togglePlay()` — do NOT destroy and recreate (destroy+create leaves the new controller in a not-ready state)

### Song Sorting
- Songs API display order (autoShuffle on): pinned songs at `pinnedPosition`, then `lastPreQueuedId` at position 0, then locked songs at sortOrder index, then unlocked sorted by `netScore` descending filling gaps
- `reorderByVotes()` updates `sortOrder` in DB after each vote — respects pinned positions (pinned songs placed at `pinnedPosition`, locked songs keep index, only unlocked get new sortOrders)
- Lock endpoint and `reorderByVotes` both use `startOrder = playingSong.sortOrder + 1` to keep sortOrder numbering consistent
- Client-side `optimisticReorder` in guest view defers reorder by 1s after last vote to prevent UI jitter

### PWA
- Service worker at `public/sw.js` — network-first with cache fallback, skips API/socket requests
- **Bump `CACHE_NAME` version** in `sw.js` on every deploy that changes client-facing code, or users see stale content
- `src/lib/pwa.ts` — shared hooks: `useIsStandalone()`, `useNetworkStatus()`, `useAppHeight()`
- `useAppHeight()` sets `--app-height` CSS var using `screen.height` in standalone PWA (not `window.innerHeight` which excludes the status bar area on iOS)

### Desktop vs Mobile Isolation
**ALL UI changes must respect desktop/mobile separation.** Desktop uses `lg:` and `xl:` Tailwind breakpoints ONLY. Never let a desktop-targeted change affect mobile/PWA layout, visuals, or functionality. Always verify changes won't bleed across breakpoints.

### Key Files
- `src/lib/db.ts` — Prisma singleton with Neon Postgres adapter
- `src/lib/auth.ts` — NextAuth config, Spotify OAuth scopes, token refresh in session callback
- `src/lib/spotify.ts` — All Spotify API wrappers (playback, search, queue, devices)
- `src/lib/queue.ts` — Shared `getNextSong()` + `shiftPinnedPositions()` helpers (getNextSong must match display sort order exactly)
- `src/lib/socket.ts` — Client-side Socket.io singleton with `getSocket()` accessor and no-op stub fallback
- `src/lib/reorder.ts` — Queue reordering algorithm (only updates unlocked songs; locked songs keep exact sortOrder)
- `src/lib/pwa.ts` — PWA detection hooks (standalone, network status, app height)
- `src/app/dashboard/DashboardClient.tsx` — Owner dashboard (room management, queue, mini-player, fade controls)
- `src/app/room/[code]/page.tsx` — Guest room view (voting, song requests, search)
- `src/app/api/cron/sync-rooms/route.ts` — Background sync: detects song transitions, pre-queues, external recovery
- `src/app/api/cron/fade-transition/route.ts` — Server-side fade endpoint (called by socket server, auth via CRON_SECRET)
- `src/app/api/rooms/[code]/fade-skip/route.ts` — Client-side fade endpoint (auth via session, supports mode: "skip" | "pause")
- `src/app/api/rooms/[code]/lock/route.ts` — DJ lock: simple toggle with `forceLock` option; also has legacy position-based lock path (`maxDuration = 30`)
- `src/app/api/rooms/[code]/lock-next/route.ts` — Locks next song and sets lastPreQueuedId for "Queued Next" UI
- `src/app/api/rooms/[code]/sync/route.ts` — Returns current Spotify track info + room state for polling
- `socket-server.ts` — Standalone Socket.io server with sync loop and server-side fade triggering

### Environment Variables
- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` — Spotify app credentials
- `NEXTAUTH_SECRET`, `NEXTAUTH_URL` — NextAuth config
- `DATABASE_URL` — Neon Postgres connection string (pooler endpoint with sslmode=require)
- `NEXT_PUBLIC_SOCKET_URL` — Socket.io server URL (e.g., `https://crowddj-socket.fly.dev`)
- `CRON_SECRET` — Shared secret between socket server and cron endpoints

### Deployment Notes
- **Vercel env vars via CLI**: Use `printf 'value' | vercel env add` NOT `echo` (echo adds trailing newline which corrupts URLs/tokens)
- **Vercel auto-deploy**: `git push origin main` auto-deploys to production
- **NextAuth v5 signin**: Must use `signIn("spotify")` from `next-auth/react` (POST+CSRF). Direct GET to signin URL throws `UnknownAction`
- Auth config needs `trustHost: true` and `basePath: "/api/auth"` for Vercel
- Spotify app is in "Development mode" — redirect URIs: `https://crowddj.vercel.app/api/auth/callback/spotify` and `https://www.partyqueue.com/api/auth/callback/spotify`
- **Fly.io deploy wipes in-memory state** (`backgroundRooms`, `fadingRooms`) — rooms re-register when clients reconnect
- **`maxDuration` on Vercel**: Any API route that runs a fade loop or long operation needs `export const maxDuration = 60` or it times out at 10s

### Testing
No test framework is configured. There are no test files in the project. Validate changes via `npm run build` + manual testing on the deployed app.

## Production URLs
- App: https://crowddj.vercel.app
- Socket: https://crowddj-socket.fly.dev
- GitHub: https://github.com/fulleralltheway/crowddj
- Neon DB: ep-tiny-frog-a4yf3eo4-pooler.us-east-1.aws.neon.tech/neondb
- Domain: https://www.partyqueue.com
