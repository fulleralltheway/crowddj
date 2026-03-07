import { createServer } from "http";
import { Server } from "socket.io";

const VERCEL_URL = process.env.VERCEL_URL || "https://crowddj.vercel.app";
const CRON_SECRET = process.env.CRON_SECRET || "";
const SYNC_INTERVAL = 10_000; // 10 seconds
const CORS_ORIGINS = [
  VERCEL_URL,
  "https://crowddj.vercel.app",
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

  // Client signals that something changed — fetch fresh data and broadcast
  socket.on("vote-update", async (roomCode: string) => {
    await broadcastSongs(roomCode);
  });

  socket.on("song-requested", async (roomCode: string) => {
    await broadcastSongs(roomCode);
    io.to(roomCode).emit("request-received");
  });

  socket.on("song-skipped", async (roomCode: string) => {
    await broadcastSongs(roomCode);
  });

  socket.on("request-handled", async (roomCode: string) => {
    await broadcastSongs(roomCode);
  });

  socket.on("songs-reordered", async (roomCode: string) => {
    await broadcastSongs(roomCode);
  });

  socket.on("room-settings-changed", async (roomCode: string) => {
    await broadcastRoomState(roomCode);
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

// Background sync loop — keeps rooms alive even with zero browser tabs open
async function syncAllRooms() {
  if (activeRooms.size === 0 && !CRON_SECRET) return; // Nothing to sync

  try {
    // Call the Vercel cron endpoint which handles all Spotify sync logic
    const url = `${VERCEL_URL}/api/cron/sync-rooms?secret=${encodeURIComponent(CRON_SECRET)}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      // If any rooms advanced or changed, broadcast updates
      for (const result of data.results || []) {
        if (["advanced", "advanced_playback", "pre_queued", "external_override", "no_playback"].includes(result.status)) {
          await broadcastSongs(result.code);
        }
      }
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
