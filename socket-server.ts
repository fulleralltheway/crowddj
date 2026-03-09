import { createServer } from "http";
import { Server } from "socket.io";

const VERCEL_URL = process.env.VERCEL_URL || "https://crowddj.vercel.app";
const CRON_SECRET = process.env.CRON_SECRET || "";
const SYNC_INTERVAL = 10_000; // 10 seconds — balanced between responsiveness and rate limits
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
    res.end(JSON.stringify({ status: "ok", rooms: activeRooms.size }));
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

// Track rooms currently being faded (prevent double-triggers)
const fadingRooms = new Set<string>();

function getRoomCount(roomCode: string): number {
  return activeRooms.get(roomCode)?.size || 0;
}

io.on("connection", (socket) => {
  let currentRoom: string | null = null;

  socket.on("join-room", (roomCode: string) => {
    if (currentRoom) {
      socket.leave(currentRoom);
      activeRooms.get(currentRoom)?.delete(socket.id);
      if (activeRooms.get(currentRoom)?.size === 0) activeRooms.delete(currentRoom);
      io.to(currentRoom).emit("guest-count", getRoomCount(currentRoom));
    }

    socket.join(roomCode);
    currentRoom = roomCode;

    if (!activeRooms.has(roomCode)) activeRooms.set(roomCode, new Set());
    activeRooms.get(roomCode)!.add(socket.id);

    // Send guest count to everyone in the room
    io.to(roomCode).emit("guest-count", getRoomCount(roomCode));

    console.log(`[${roomCode}] Client joined (${getRoomCount(roomCode)} connected)`);
  });

  socket.on("leave-room", (roomCode: string) => {
    socket.leave(roomCode);
    activeRooms.get(roomCode)?.delete(socket.id);
    if (activeRooms.get(roomCode)?.size === 0) activeRooms.delete(roomCode);
    if (currentRoom === roomCode) currentRoom = null;
    io.to(roomCode).emit("guest-count", getRoomCount(roomCode));
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

  socket.on("room-settings-changed", async (roomCode: string) => {
    await broadcastRoomState(roomCode); // Immediate — settings are infrequent
  });

  socket.on("room-closed", (roomCode: string) => {
    io.to(roomCode).emit("room-closed");
    console.log(`[${roomCode}] Room closed by host`);
    // Clean up tracking
    activeRooms.delete(roomCode);
  });

  socket.on("disconnect", () => {
    if (currentRoom) {
      activeRooms.get(currentRoom)?.delete(socket.id);
      if (activeRooms.get(currentRoom)?.size === 0) activeRooms.delete(currentRoom);
      io.to(currentRoom).emit("guest-count", getRoomCount(currentRoom));
      console.log(`[${currentRoom}] Client left (${getRoomCount(currentRoom)} connected)`);
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
async function triggerServerFade(roomCode: string) {
  if (fadingRooms.has(roomCode)) return;
  fadingRooms.add(roomCode);
  console.log(`[${roomCode}] Triggering server-side fade transition`);

  try {
    const url = `${VERCEL_URL}/api/cron/fade-transition?secret=${encodeURIComponent(CRON_SECRET)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomCode }),
    });
    const result = await res.json();
    console.log(`[${roomCode}] Fade result:`, JSON.stringify(result));

    // Broadcast updated state to all clients
    await broadcastSongs(roomCode);
    await broadcastRoomState(roomCode);
  } catch (err) {
    console.error(`[${roomCode}] Server fade error:`, err);
  } finally {
    fadingRooms.delete(roomCode);
  }
}

// Background sync loop — only runs when clients are connected
async function syncAllRooms() {
  if (!CRON_SECRET) {
    console.warn("CRON_SECRET not set — sync loop disabled");
    return;
  }

  // Skip sync if no active rooms — prevents hammering Turso when idle
  if (activeRooms.size === 0) return;

  try {
    // Only sync rooms that have connected clients (not all active rooms in DB)
    const connectedRooms = Array.from(activeRooms.keys()).join(",");
    const url = `${VERCEL_URL}/api/cron/sync-rooms?secret=${encodeURIComponent(CRON_SECRET)}&rooms=${encodeURIComponent(connectedRooms)}&deferFade=true`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const nonPlaying = (data.results || []).filter((r: any) => r.status !== "playing" && r.status !== "no_current_song");
      if (nonPlaying.length > 0) {
        console.log("Sync results:", JSON.stringify(nonPlaying));
      }
      // If any rooms advanced or changed, broadcast updates to connected clients
      for (const result of data.results || []) {
        if (result.status !== "playing" && result.status !== "no_current_song" && result.status !== "debounced") {
          // needs_fade means the cron detected a song past its max duration
          // and no client is handling the fade — trigger server-side fade
          if (result.status === "needs_fade" && !fadingRooms.has(result.code)) {
            triggerServerFade(result.code);
          }

          await broadcastSongs(result.code);
          // Broadcast room state when lastPreQueuedId changes (queued_next sets it, advanced/advanced_prequeued clears it)
          if (result.status === "queued_next" || result.status === "advanced" || result.status === "advanced_prequeued" || result.status === "prequeued_maxdur") {
            await broadcastRoomState(result.code);
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

// Start background loops
setInterval(syncAllRooms, SYNC_INTERVAL);
setInterval(broadcastServerTime, 30_000); // Sync clocks every 30s

const PORT = parseInt(process.env.PORT || "3001", 10);
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Socket.io server running on port ${PORT}`);
  console.log(`VERCEL_URL: ${VERCEL_URL}`);
  console.log(`CRON_SECRET: ${CRON_SECRET ? "set" : "NOT SET"}`);
});
