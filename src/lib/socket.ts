"use client";

import { io, Socket } from "socket.io-client";

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    const url = process.env.NEXT_PUBLIC_SOCKET_URL;
    if (!url) {
      // Return a no-op socket stub when no socket server is configured
      return {
        emit: () => {},
        on: () => {},
        off: () => {},
        connect: () => {},
        disconnect: () => {},
        connected: false,
      } as unknown as Socket;
    }
    socket = io(url, {
      transports: ["websocket", "polling"],
    });
  }
  return socket;
}
