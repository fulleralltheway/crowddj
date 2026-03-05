import { createServer } from "http";
import { Server } from "socket.io";

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: {
    origin: process.env.NEXTAUTH_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  socket.on("join-room", (roomCode: string) => {
    socket.join(roomCode);
  });

  socket.on("leave-room", (roomCode: string) => {
    socket.leave(roomCode);
  });

  socket.on("vote-update", (roomCode: string) => {
    // Broadcast to all clients in the room that votes changed
    io.to(roomCode).emit("playlist-updated");
  });

  socket.on("song-requested", (roomCode: string) => {
    io.to(roomCode).emit("playlist-updated");
    io.to(roomCode).emit("request-received");
  });

  socket.on("song-skipped", (roomCode: string) => {
    io.to(roomCode).emit("playlist-updated");
  });

  socket.on("request-handled", (roomCode: string) => {
    io.to(roomCode).emit("playlist-updated");
  });
});

const PORT = parseInt(process.env.SOCKET_PORT || "3001", 10);
httpServer.listen(PORT, () => {
  console.log(`Socket.io server running on port ${PORT}`);
});
