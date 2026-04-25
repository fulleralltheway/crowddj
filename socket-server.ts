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

io.on("connection", (socket) => {
  let currentRoom: string | null = null;

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
async function syncAllRooms() {
  if (!CRON_SECRET) {
    console.warn("CRON_SECRET not set — sync loop disabled");
    return;
  }

  const allRooms = getAllSyncRooms();
  if (allRooms.length === 0) return;

  try {
    const roomsList = allRooms.join(",");
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

// Start background loops
setInterval(syncAllRooms, SYNC_INTERVAL);
setInterval(syncPlaylists, PLAYLIST_SYNC_INTERVAL);
setInterval(broadcastServerTime, 30_000); // Sync clocks every 30s

const PORT = parseInt(process.env.PORT || "3001", 10);
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Socket.io server running on port ${PORT}`);
  console.log(`VERCEL_URL: ${VERCEL_URL}`);
  console.log(`CRON_SECRET: ${CRON_SECRET ? "set" : "NOT SET"}`);
});
