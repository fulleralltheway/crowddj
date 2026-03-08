# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CrowdDJ — a crowd-sourced DJ app where hosts connect Spotify, create rooms from playlists, and guests vote on songs via mobile/PWA. The queue reorders by net votes in real-time.

## Commands

```bash
npm run dev              # Next.js dev server (port 3000)
npm run dev:socket       # Socket.io server (port 3001)
npm run dev:all          # Both servers concurrently
npm run build            # prisma generate && next build
npm run lint             # ESLint
npx vercel --prod        # Deploy to Vercel production
fly deploy               # Deploy socket server to Fly.io
```

### Database

```bash
npx prisma generate      # Regenerate Prisma client (output: src/generated/prisma)
npx prisma studio        # Open Prisma Studio GUI
```

Schema changes cannot be pushed to Turso directly with `prisma db push`. Tables are created on Turso via direct SQL using `@libsql/client`.

## Architecture

### Tech Stack
- **Next.js 16** (App Router) + TypeScript + **Tailwind CSS v4** (`@theme inline` for custom vars)
- **Prisma 7** with SQLite via `@prisma/adapter-libsql` (Turso in production, `file:prisma/dev.db` locally)
- **NextAuth v5 beta** with custom Prisma adapter (`src/lib/prisma-adapter.ts`)
- **Socket.io** for real-time updates (separate server, not Vercel-compatible)
- **FingerprintJS** for device-based guest identity (anti-abuse)

### Prisma 7 Specifics
- Adapter pattern required: `new PrismaClient({ adapter })` — no zero-arg constructor
- Import from `@/generated/prisma/client` (not `@/generated/prisma`)
- Adapter class is `PrismaLibSql` (not `PrismaLibSQL`) from `@prisma/adapter-libsql`
- `PrismaLibSql` takes `{ url, authToken }` config object, NOT a `@libsql/client` Client instance
- `prisma.config.ts` lives at project root (not in `prisma/` dir)
- Schema datasource has no `url` field (moved to prisma.config.ts)

### Three-Part Runtime Architecture

1. **Next.js on Vercel** — UI + API routes. All API endpoints under `src/app/api/rooms/[code]/`. The `auth()` call in API routes provides session with `(session as any).accessToken` for Spotify API calls.

2. **Socket.io on Fly.io** (`socket-server.ts`, `Dockerfile.socket`) — Real-time event relay + background sync loop. Runs a 5-second interval calling the Vercel cron endpoint, then broadcasts song/room updates to connected clients. Key events: `songs-update`, `room-update`, `vote-update`, `songs-reordered`, `song-requested`, `room-settings-changed`.

3. **Spotify Web API** (`src/lib/spotify.ts`) — Playback control, search, playlist import. Token refresh happens in both `auth.ts` (session callback) and `cron/sync-rooms` (direct refresh from Account table).

### Song Lifecycle & Queue Management
- Songs are imported from a Spotify playlist into `RoomSong` rows with `sortOrder`
- Guests vote; the reorder algorithm (`src/lib/reorder.ts`) sorts unplayed songs by net score
- At ~15s remaining on current song, the cron pre-queues the next song via Spotify's queue API, sets `room.lastPreQueuedId` and `song.isLocked = true`
- When Spotify naturally advances, cron detects the URI change and marks songs as played/playing
- **Manual DJ lock** (`isLocked && lastPreQueuedId !== song.id`): owner override, hides votes, yellow highlight
- **Auto-queue lock** (`isLocked && lastPreQueuedId === song.id`): cron-triggered, shows votes dimmed, accent highlight with "Up Next"/"Queued Next" label

### Song Sorting
- Songs API endpoints (`/api/rooms/[code]` and `/api/rooms/[code]/songs`) sort by `netScore` descending at read time when `autoShuffle` is on, not just by `sortOrder`
- `reorderByVotes()` still updates `sortOrder` in DB after each vote, but the API sort is the authoritative display order
- Client-side `optimisticReorder` in guest view defers reorder by 1s after last vote to prevent UI jitter
- Post-vote server sync fires 800ms after last vote, waits for in-flight votes, then fetches authoritative data

### PWA
- Service worker at `public/sw.js` — network-first with cache fallback, skips API/socket requests
- **Bump `CACHE_NAME` version** in `sw.js` on every deploy that changes client-facing code, or users see stale content
- `src/lib/pwa.ts` — shared hooks: `useIsStandalone()`, `useNetworkStatus()`, `useAppHeight()`
- `useAppHeight()` sets `--app-height` CSS var using `screen.height` in standalone PWA (not `window.innerHeight` which excludes the status bar area on iOS)
- `src/app/ServiceWorker.tsx` — registers SW on mount
- Splash screens and maskable icons configured in `src/app/layout.tsx` and `public/manifest.json`

### Key Files
- `src/lib/db.ts` — Prisma singleton with Turso/local SQLite adapter detection
- `src/lib/auth.ts` — NextAuth config, Spotify OAuth scopes, token refresh in session callback
- `src/lib/spotify.ts` — All Spotify API wrappers (playback, search, queue, devices)
- `src/lib/socket.ts` — Client-side Socket.io singleton with no-op stub fallback
- `src/lib/reorder.ts` — Queue reordering algorithm
- `src/lib/pwa.ts` — PWA detection hooks (standalone, network status, app height)
- `src/app/dashboard/DashboardClient.tsx` — Owner dashboard (room management, queue, mini-player)
- `src/app/room/[code]/page.tsx` — Guest room view (voting, song requests, search)
- `src/app/api/cron/sync-rooms/route.ts` — Background sync: detects song transitions, pre-queues next song
- `src/app/api/rooms/[code]/sync/route.ts` — Returns current Spotify track info + room state for polling
- `socket-server.ts` — Standalone Socket.io server with sync loop
- `public/sw.js` — Service worker (bump CACHE_NAME on deploy!)

### Environment Variables
- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` — Spotify app credentials
- `NEXTAUTH_SECRET`, `NEXTAUTH_URL` — NextAuth config
- `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` — Production database
- `DATABASE_URL` — Set to `file:///tmp/dev.db` on Vercel (unused with adapter, but required by Prisma)
- `NEXT_PUBLIC_SOCKET_URL` — Socket.io server URL (e.g., `https://crowddj-socket.fly.dev`)
- `CRON_SECRET` — Shared secret between socket server and cron endpoint

### Deployment Notes
- **Vercel env vars via CLI**: Use `printf 'value' | vercel env add` NOT `echo` (echo adds trailing newline which corrupts URLs/tokens)
- **NextAuth v5 signin**: Must use `signIn("spotify")` from `next-auth/react` (POST+CSRF). Direct GET to signin URL throws `UnknownAction`
- Auth config needs `trustHost: true` and `basePath: "/api/auth"` for Vercel
- Spotify app is in "Development mode" — redirect URI: `https://crowddj.vercel.app/api/auth/callback/spotify`

## Production URLs
- App: https://crowddj.vercel.app
- Socket: https://crowddj-socket.fly.dev
- GitHub: https://github.com/fulleralltheway/crowddj
- Turso DB: libsql://crowddj-fulleralltheway.aws-us-east-1.turso.io
