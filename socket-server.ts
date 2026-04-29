import { createServer } from "http";
import { Server } from "socket.io";

const VERCEL_URL = process.env.VERCEL_URL || "https://crowddj.vercel.app";
const CRON_SECRET = process.env.CRON_SECRET || "";
const SYNC_INTERVAL = 5_000; // 5 seconds — snappier server-side transitions
const BACKGROUND_ROOM_TTL = 4 * 60 * 60 * 1000; // 4 hours — auto-expire stale background rooms
const CORS_ORIGINS = [
  VERCEL_URL,
  "https://crowddj.vercel.app",
  "https://www.partyqueue.com",
  "https://partyqueue.com",
  "http://localhost:3000",
];

const httpServer = createServer((req, res) => {
  // Health check endpoint for Fly.io
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", rooms: activeRooms.size, backgroundRooms: backgroundRooms.size, scheduledFades: scheduledFades.size }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const io = new Server(httpServer, {
  cors: {
    origin: CORS_ORIGINS,
    methods: ["GET", "POST"],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Track active rooms and their client counts
const activeRooms = new Map<string, Set<string>>(); // roomCode -> set of socket IDs

// Rooms that should keep syncing even when all clients disconnect.
// Stores last activity timestamp — auto-expires after BACKGROUND_ROOM_TTL.
const backgroundRooms = new Map<string, number>(); // roomCode -> last activity timestamp

// Track rooms currently being faded (prevent double-triggers)
const fadingRooms = new Set<string>();

// Scheduled fade timers — set when pre-queue fires, fires at threshold for precise timing
const scheduledFades = new Map<string, ReturnType<typeof setTimeout>>();

// Bluegrass DJ — parallel session machinery (no rooms, no songs, one playlist
// + threshold-fade per active session). See ADR 0001 in spotifyapp/.studio.
const activeSessions = new Map<string, Set<string>>(); // sessionId -> set of socket IDs (usually 1)
const backgroundSessions = new Map<string, number>(); // sessionId -> last activity timestamp
const fadingSessions = new Set<string>();
const scheduledSessionFades = new Map<string, ReturnType<typeof setTimeout>>();
const BACKGROUND_SESSION_TTL = 4 * 60 * 60 * 1000; // 4h, mirrors BACKGROUND_ROOM_TTL

function getRoomCount(roomCode: string): number {
  return activeRooms.get(roomCode)?.size || 0;
}

// Debounced DB-backed guest count broadcast — fetches named guests from the API
// so the count only reflects real guests (not the host's socket connection)
const guestCountTimers = new Map<string, ReturnType<typeof setTimeout>>();

async function broadcastGuestCount(roomCode: string, delayMs = 1000) {
  if (guestCountTimers.has(roomCode)) clearTimeout(guestCountTimers.get(roomCode)!);
  guestCountTimers.set(roomCode, setTimeout(async () => {
    guestCountTimers.delete(roomCode);
    try {
      const res = await fetch(`${VERCEL_URL}/api/rooms/${roomCode}/guests`);
      if (res.ok) {
        const data = await res.json();
        io.to(roomCode).emit("guest-count", data.count);
      }
    } catch (err) {
      console.error(`[${roomCode}] Failed to broadcast guest count:`, err);
    }
  }, delayMs));
}

// Get all rooms that need syncing — connected clients + background rooms
function getAllSyncRooms(): string[] {
  const rooms = new Set<string>();
  for (const code of activeRooms.keys()) rooms.add(code);
  // Expire stale background rooms
  const now = Date.now();
  for (const [code, lastActive] of backgroundRooms) {
    if (now - lastActive > BACKGROUND_ROOM_TTL) {
      backgroundRooms.delete(code);
      console.log(`[${code}] Background room expired (inactive ${Math.round((now - lastActive) / 3600000)}h)`);
    } else {
      rooms.add(code);
    }
  }
  return Array.from(rooms);
}

// Active rooms only (clients connected) — synced at the fast cadence so
// pre-queue scheduling stays accurate.
function getActiveRoomsOnly(): string[] {
  return Array.from(activeRooms.keys());
}

// Background-only rooms (no clients connected). Synced at a slower cadence
// to relieve Spotify rate-limit pressure. Still preserves pre-queue
// detection for thresholds >= 30s (15s pre-queue window > 10s sync interval).
function getBackgroundOnlyRooms(): string[] {
  const rooms: string[] = [];
  const now = Date.now();
  for (const [code, lastActive] of backgroundRooms) {
    if (now - lastActive > BACKGROUND_ROOM_TTL) {
      backgroundRooms.delete(code);
      console.log(`[${code}] Background room expired (inactive ${Math.round((now - lastActive) / 3600000)}h)`);
      continue;
    }
    if (!activeRooms.has(code)) rooms.push(code);
  }
  return rooms;
}

io.on("connection", (socket) => {
  let currentRoom: string | null = null;
  let currentSession: string | null = null;

  // Bluegrass DJ session join/leave/end. Mirrors join-room but for sessions.
  socket.on("join-session", (sessionId: string) => {
    if (currentSession) {
      socket.leave(`session:${currentSession}`);
      activeSessions.get(currentSession)?.delete(socket.id);
      if (activeSessions.get(currentSession)?.size === 0) activeSessions.delete(currentSession);
    }
    socket.join(`session:${sessionId}`);
    currentSession = sessionId;
    if (!activeSessions.has(sessionId)) activeSessions.set(sessionId, new Set());
    activeSessions.get(sessionId)!.add(socket.id);
    backgroundSessions.set(sessionId, Date.now());
    console.log(`[session:${sessionId}] Client joined (${activeSessions.get(sessionId)!.size} connected)`);
  });

  socket.on("leave-session", (sessionId: string) => {
    socket.leave(`session:${sessionId}`);
    activeSessions.get(sessionId)?.delete(socket.id);
    if (activeSessions.get(sessionId)?.size === 0) activeSessions.delete(sessionId);
    if (currentSession === sessionId) currentSession = null;
    // Note: session stays in backgroundSessions so sync continues even with no clients connected
  });

  socket.on("session-ended", (sessionId: string) => {
    io.to(`session:${sessionId}`).emit("session-ended");
    console.log(`[session:${sessionId}] Session ended by user`);
    activeSessions.delete(sessionId);
    backgroundSessions.delete(sessionId);
    if (scheduledSessionFades.has(sessionId)) {
      clearTimeout(scheduledSessionFades.get(sessionId)!);
      scheduledSessionFades.delete(sessionId);
    }
  });

  socket.on("join-room", (roomCode: string) => {
    if (currentRoom) {
      socket.leave(currentRoom);
      activeRooms.get(currentRoom)?.delete(socket.id);
      if (activeRooms.get(currentRoom)?.size === 0) activeRooms.delete(currentRoom);
      broadcastGuestCount(currentRoom);
    }

    socket.join(roomCode);
    currentRoom = roomCode;

    if (!activeRooms.has(roomCode)) activeRooms.set(roomCode, new Set());
    activeRooms.get(roomCode)!.add(socket.id);

    // Room is known — keep syncing it even if everyone leaves later
    backgroundRooms.set(roomCode, Date.now());

    // Send DB-backed guest count to everyone in the room
    broadcastGuestCount(roomCode);

    console.log(`[${roomCode}] Client joined (${getRoomCount(roomCode)} connected)`);
  });

  socket.on("leave-room", (roomCode: string) => {
    socket.leave(roomCode);
    activeRooms.get(roomCode)?.delete(socket.id);
    if (activeRooms.get(roomCode)?.size === 0) activeRooms.delete(roomCode);
    if (currentRoom === roomCode) currentRoom = null;
    broadcastGuestCount(roomCode);
    // Note: room stays in backgroundRooms so sync continues
  });

  // Client signals that something changed — debounced to coalesce rapid events
  socket.on("vote-update", (roomCode: string) => {
    debouncedBroadcastSongs(roomCode);
  });

  socket.on("song-requested", (roomCode: string) => {
    debouncedBroadcastSongs(roomCode);
    io.to(roomCode).emit("request-received");
  });

  socket.on("song-skipped", async (roomCode: string) => {
    await broadcastSongs(roomCode); // Immediate — user expects instant feedback
  });

  socket.on("request-handled", (roomCode: string) => {
    debouncedBroadcastSongs(roomCode);
  });

  socket.on("songs-reordered", async (roomCode: string) => {
    await broadcastSongs(roomCode); // Immediate — host drag-and-drop
  });

  // Dashboard detected a song change in Spotify — broadcast immediately
  socket.on("song-changed", async (roomCode: string) => {
    await broadcastSongs(roomCode);
    await broadcastRoomState(roomCode);
  });

  // Guest submitted their name — refresh DB-backed count quickly
  socket.on("guest-named", (roomCode: string) => {
    broadcastGuestCount(roomCode, 500);
  });

  socket.on("room-settings-changed", async (roomCode: string) => {
    await broadcastRoomState(roomCode); // Immediate — settings are infrequent
  });

  socket.on("room-closed", (roomCode: string) => {
    io.to(roomCode).emit("room-closed");
    console.log(`[${roomCode}] Room closed by host`);
    // Clean up all tracking — room is done
    activeRooms.delete(roomCode);
    backgroundRooms.delete(roomCode);
    if (scheduledFades.has(roomCode)) {
      clearTimeout(scheduledFades.get(roomCode)!);
      scheduledFades.delete(roomCode);
    }
  });

  socket.on("disconnect", () => {
    if (currentRoom) {
      activeRooms.get(currentRoom)?.delete(socket.id);
      if (activeRooms.get(currentRoom)?.size === 0) activeRooms.delete(currentRoom);
      broadcastGuestCount(currentRoom);
      console.log(`[${currentRoom}] Client left (${getRoomCount(currentRoom)} connected)`);
      // Note: room stays in backgroundRooms so sync continues
    }
    if (currentSession) {
      activeSessions.get(currentSession)?.delete(socket.id);
      if (activeSessions.get(currentSession)?.size === 0) activeSessions.delete(currentSession);
      console.log(`[session:${currentSession}] Client left`);
      // Note: session stays in backgroundSessions so sync continues
    }
  });
});

// Debounced broadcast — coalesces rapid calls (e.g., multiple votes within 500ms) into one fetch
const songsBroadcastTimers = new Map<string, ReturnType<typeof setTimeout>>();
const roomStateBroadcastTimers = new Map<string, ReturnType<typeof setTimeout>>();

function debouncedBroadcastSongs(roomCode: string, delayMs = 500) {
  if (songsBroadcastTimers.has(roomCode)) clearTimeout(songsBroadcastTimers.get(roomCode)!);
  songsBroadcastTimers.set(roomCode, setTimeout(() => {
    songsBroadcastTimers.delete(roomCode);
    broadcastSongs(roomCode);
  }, delayMs));
}

function debouncedBroadcastRoomState(roomCode: string, delayMs = 500) {
  if (roomStateBroadcastTimers.has(roomCode)) clearTimeout(roomStateBroadcastTimers.get(roomCode)!);
  roomStateBroadcastTimers.set(roomCode, setTimeout(() => {
    roomStateBroadcastTimers.delete(roomCode);
    broadcastRoomState(roomCode);
  }, delayMs));
}

// Fetch songs from Vercel API and broadcast to all clients in the room
async function broadcastSongs(roomCode: string) {
  try {
    const res = await fetch(`${VERCEL_URL}/api/rooms/${roomCode}/songs`);
    if (res.ok) {
      const songs = await res.json();
      io.to(roomCode).emit("songs-update", songs);
    }
  } catch (err) {
    console.error(`[${roomCode}] Failed to fetch songs:`, err);
  }
}

// Fetch full room state and broadcast
async function broadcastRoomState(roomCode: string) {
  try {
    const res = await fetch(`${VERCEL_URL}/api/rooms/${roomCode}`);
    if (res.ok) {
      const room = await res.json();
      io.to(roomCode).emit("room-update", room);
    }
  } catch (err) {
    console.error(`[${roomCode}] Failed to fetch room:`, err);
  }
}

// Trigger a server-side fade transition via the Vercel endpoint
// Runs in the background — doesn't block the sync loop
async function triggerServerFade(roomCode: string, expectedSongId?: string) {
  if (fadingRooms.has(roomCode)) return;
  fadingRooms.add(roomCode);
  console.log(`[${roomCode}] Triggering server-side fade transition`);

  try {
    const url = `${VERCEL_URL}/api/cron/fade-transition?secret=${encodeURIComponent(CRON_SECRET)}`;
    const body: Record<string, string> = { roomCode };
    if (expectedSongId) body.expectedSongId = expectedSongId;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    console.log(`[${roomCode}] Fade result:`, JSON.stringify(result));

    // Broadcast updated state to all clients (if any are connected)
    if (activeRooms.has(roomCode)) {
      await broadcastSongs(roomCode);
      await broadcastRoomState(roomCode);
    }
  } catch (err) {
    console.error(`[${roomCode}] Server fade error:`, err);
  } finally {
    fadingRooms.delete(roomCode);
  }
}

// Background sync loop — syncs all known rooms (connected + background)
async function syncRoomsList(roomCodes: string[]) {
  if (!CRON_SECRET) {
    console.warn("CRON_SECRET not set — sync loop disabled");
    return;
  }

  if (roomCodes.length === 0) return;

  try {
    const roomsList = roomCodes.join(",");
    const url = `${VERCEL_URL}/api/cron/sync-rooms?secret=${encodeURIComponent(CRON_SECRET)}&rooms=${encodeURIComponent(roomsList)}&deferFade=true`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const nonPlaying = (data.results || []).filter((r: any) => r.status !== "playing" && r.status !== "no_current_song");
      if (nonPlaying.length > 0) {
        console.log("Sync results:", JSON.stringify(nonPlaying));
      }
      // Process results for all rooms
      for (const result of data.results || []) {
        // Room closed/expired — stop tracking it
        if (result.status === "room_closed" || result.status === "room_expired") {
          backgroundRooms.delete(result.code);
          activeRooms.delete(result.code);
          if (scheduledFades.has(result.code)) {
            clearTimeout(scheduledFades.get(result.code)!);
            scheduledFades.delete(result.code);
          }
          console.log(`[${result.code}] Room ended — removed from sync`);
          continue;
        }

        // Cancel scheduled fades if the song already advanced (client handled it)
        if (scheduledFades.has(result.code) &&
            (result.status === "advanced" || result.status === "advanced_prequeued" || result.status === "advanced_external")) {
          clearTimeout(scheduledFades.get(result.code)!);
          scheduledFades.delete(result.code);
        }

        // Refresh TTL for rooms that are actively playing
        if (result.status === "playing" && backgroundRooms.has(result.code)) {
          backgroundRooms.set(result.code, Date.now());
        }

        if (result.status !== "playing" && result.status !== "no_current_song" && result.status !== "debounced") {
          // needs_fade means the cron detected a song past its max duration
          // and no client is handling the fade — trigger server-side fade
          // (only if no scheduled fade is already pending for precise timing)
          if (result.status === "needs_fade" && !fadingRooms.has(result.code)) {
            if (!scheduledFades.has(result.code)) {
              triggerServerFade(result.code);
            }
          }

          // Schedule a precise fade when pre-queue fires — triggers at
          // approximately the fade-start time (threshold minus fade duration)
          // instead of waiting for the next sync cycle to detect needs_fade.
          if (result.status === "prequeued_maxdur" && result.fadeInMs && result.currentSongId) {
            if (!scheduledFades.has(result.code) && !fadingRooms.has(result.code)) {
              // Phase 1A: fade should END at the threshold, so START it
              // (fadeDurationMs + 500ms jitter buffer) before the threshold.
              // fadeInMs = ms until maxMs threshold; fadeDurationMs = full fade length.
              // Fallback to 3000ms if fadeDurationMs missing (older cron payloads).
              const fadeDurationMs = (result as { fadeDurationMs?: number }).fadeDurationMs ?? 3000;
              const delay = Math.max(1000, result.fadeInMs - fadeDurationMs - 500);
              console.log(`[${result.code}] Scheduling server fade in ${delay}ms (threshold in ${result.fadeInMs}ms, fadeDuration ${fadeDurationMs}ms)`);
              const fadeRoomCode = result.code;
              const fadeSongId = result.currentSongId;
              const timer = setTimeout(() => {
                scheduledFades.delete(fadeRoomCode);
                triggerServerFade(fadeRoomCode, fadeSongId);
              }, delay);
              scheduledFades.set(result.code, timer);
            }
          }

          // Only broadcast to rooms with connected clients
          if (activeRooms.has(result.code)) {
            await broadcastSongs(result.code);
            if (result.status === "queued_next" || result.status === "advanced" || result.status === "advanced_prequeued" || result.status === "prequeued_maxdur") {
              await broadcastRoomState(result.code);
            }
          }
        }
      }
    } else {
      console.error(`Sync loop got ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.error("Sync loop error:", err);
  }
}

// Server time broadcast — keeps vote reset timers in sync across all clients
function broadcastServerTime() {
  for (const [roomCode] of activeRooms) {
    io.to(roomCode).emit("server-time", Date.now());
  }
}

// Playlist sync loop — checks for new songs added to Spotify playlists (every 60s)
const PLAYLIST_SYNC_INTERVAL = 60_000;

async function syncPlaylists() {
  if (!CRON_SECRET) return;

  const allRooms = getAllSyncRooms();
  if (allRooms.length === 0) return;

  for (const roomCode of allRooms) {
    try {
      const url = `${VERCEL_URL}/api/rooms/${roomCode}/sync-playlist?secret=${encodeURIComponent(CRON_SECRET)}`;
      const res = await fetch(url, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        if (data.added > 0) {
          console.log(`[${roomCode}] Playlist sync: added ${data.added} new song(s)`);
          if (activeRooms.has(roomCode)) {
            await broadcastSongs(roomCode);
          }
        }
      }
    } catch (err) {
      console.error(`[${roomCode}] Playlist sync error:`, err);
    }
  }
}

// ===== Bluegrass DJ session sync (parallel pipeline to syncAllRooms) =====

function getAllSyncSessions(): string[] {
  const ids = new Set<string>();
  for (const id of activeSessions.keys()) ids.add(id);
  const now = Date.now();
  for (const [id, lastActive] of backgroundSessions) {
    if (now - lastActive > BACKGROUND_SESSION_TTL) {
      backgroundSessions.delete(id);
      console.log(`[session:${id}] Background session expired (inactive ${Math.round((now - lastActive) / 3600000)}h)`);
    } else {
      ids.add(id);
    }
  }
  return Array.from(ids);
}

function getActiveSessionsOnly(): string[] {
  return Array.from(activeSessions.keys());
}

// Sessions in backgroundSessions but with no live client. Synced at the
// slower cadence to relieve Spotify rate-limit pressure.
function getBackgroundOnlySessions(): string[] {
  const ids: string[] = [];
  const now = Date.now();
  for (const [id, lastActive] of backgroundSessions) {
    if (now - lastActive > BACKGROUND_SESSION_TTL) {
      backgroundSessions.delete(id);
      console.log(`[session:${id}] Background session expired (inactive ${Math.round((now - lastActive) / 3600000)}h)`);
      continue;
    }
    if (!activeSessions.has(id)) ids.push(id);
  }
  return ids;
}

async function triggerSessionFade(sessionId: string, expectedTrackUri?: string) {
  if (fadingSessions.has(sessionId)) return;
  fadingSessions.add(sessionId);
  console.log(`[session:${sessionId}] Triggering server-side fade transition`);
  try {
    const url = `${VERCEL_URL}/api/cron/bluegrass-fade-transition?secret=${encodeURIComponent(CRON_SECRET)}`;
    const body: Record<string, string> = { sessionId };
    if (expectedTrackUri) body.expectedTrackUri = expectedTrackUri;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    console.log(`[session:${sessionId}] Fade result:`, JSON.stringify(result));
    if (activeSessions.has(sessionId)) {
      io.to(`session:${sessionId}`).emit("session-state-changed");
    }
  } catch (err) {
    console.error(`[session:${sessionId}] Server fade error:`, err);
  } finally {
    fadingSessions.delete(sessionId);
  }
}

async function syncSessionsList(sessionIds: string[]) {
  if (!CRON_SECRET) return;
  if (sessionIds.length === 0) return;
  const ids = sessionIds;

  try {
    const url = `${VERCEL_URL}/api/cron/sync-bluegrass?secret=${encodeURIComponent(CRON_SECRET)}&sessionIds=${encodeURIComponent(ids.join(","))}&deferFade=true`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Session sync got ${res.status}: ${await res.text()}`);
      return;
    }
    const data = await res.json();
    for (const result of data.results || []) {
      if (result.status === "session_ended") {
        backgroundSessions.delete(result.id);
        activeSessions.delete(result.id);
        if (scheduledSessionFades.has(result.id)) {
          clearTimeout(scheduledSessionFades.get(result.id)!);
          scheduledSessionFades.delete(result.id);
        }
        console.log(`[session:${result.id}] Removed from sync (session ended)`);
        continue;
      }

      // Refresh background TTL for actively-playing sessions
      if (result.status === "playing" && backgroundSessions.has(result.id)) {
        backgroundSessions.set(result.id, Date.now());
      }

      // Pre-queue: schedule a precise setTimeout to fire the fade at the
      // right moment. fadeInMs is time-until-threshold; we start the fade
      // (fadeDurationMs + 500ms jitter) before so it ends at the threshold.
      if (result.status === "prequeued_maxdur" && result.fadeInMs && result.currentTrackUri) {
        if (!scheduledSessionFades.has(result.id) && !fadingSessions.has(result.id)) {
          const fadeDurationMs = result.fadeDurationMs ?? 3000;
          const delay = Math.max(1000, result.fadeInMs - fadeDurationMs - 500);
          console.log(`[session:${result.id}] Scheduling server fade in ${delay}ms (threshold in ${result.fadeInMs}ms, fadeDuration ${fadeDurationMs}ms)`);
          const id = result.id;
          const trackUri = result.currentTrackUri;
          const timer = setTimeout(() => {
            scheduledSessionFades.delete(id);
            triggerSessionFade(id, trackUri);
          }, delay);
          scheduledSessionFades.set(id, timer);
        }
      }

      // Late-arriving: cron is past threshold but no scheduled fade is queued.
      // Fire immediately. (Should be rare — usually pre-queue catches it first.)
      if (result.status === "needs_fade" && !scheduledSessionFades.has(result.id) && !fadingSessions.has(result.id)) {
        triggerSessionFade(result.id, result.currentTrackUri);
      }
    }
  } catch (err) {
    console.error("Session sync loop error:", err);
  }
}

// Background loops. Active rooms/sessions sync at SYNC_INTERVAL (5s) so
// pre-queue scheduling stays accurate; background-only ones sync at
// BACKGROUND_SYNC_INTERVAL (10s) — still inside the 15s pre-queue window
// for any threshold >= 30s, but cuts Spotify API calls in half for
// hosted-but-no-clients scenarios. Bluegrass session-min thresholds (10s)
// still get the fast path via the active-sessions loop.
const BACKGROUND_SYNC_INTERVAL = 10_000;
setInterval(() => syncRoomsList(getActiveRoomsOnly()), SYNC_INTERVAL);
setInterval(() => syncRoomsList(getBackgroundOnlyRooms()), BACKGROUND_SYNC_INTERVAL);
setInterval(() => syncSessionsList(getActiveSessionsOnly()), SYNC_INTERVAL);
setInterval(() => syncSessionsList(getBackgroundOnlySessions()), BACKGROUND_SYNC_INTERVAL);
setInterval(syncPlaylists, PLAYLIST_SYNC_INTERVAL);
setInterval(broadcastServerTime, 30_000); // Sync clocks every 30s

const PORT = parseInt(process.env.PORT || "3001", 10);
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Socket.io server running on port ${PORT}`);
  console.log(`VERCEL_URL: ${VERCEL_URL}`);
  console.log(`CRON_SECRET: ${CRON_SECRET ? "set" : "NOT SET"}`);
});
