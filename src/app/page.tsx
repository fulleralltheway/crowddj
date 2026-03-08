"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

function getLastRoom(): { code: string; roomName: string } | null {
  try {
    const raw = localStorage.getItem("crowddj_last_room");
    if (raw) return JSON.parse(raw);
  } catch {}
  // Fallback to cookie
  if (typeof document !== "undefined") {
    const match = document.cookie.match(/(?:^|; )crowddj_last_room=([^;]*)/);
    if (match) {
      try { return JSON.parse(decodeURIComponent(match[1])); } catch {}
    }
  }
  return null;
}

export default function Home() {
  const [roomCode, setRoomCode] = useState("");
  const [lastRoom, setLastRoom] = useState<{ code: string; roomName: string } | null>(null);
  const [checking, setChecking] = useState(true);
  const router = useRouter();

  // Check for a saved room and verify it's still active
  useEffect(() => {
    const saved = getLastRoom();
    if (!saved) {
      setChecking(false);
      return;
    }
    // Verify the room is still active before showing rejoin
    fetch(`/api/rooms/${saved.code}`)
      .then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          if (data.isActive) {
            setLastRoom({ code: saved.code, roomName: data.name });
          } else {
            // Room closed — clear saved data
            try { localStorage.removeItem("crowddj_last_room"); } catch {}
          }
        }
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    const code = roomCode.trim().toUpperCase();
    if (code.length >= 4) {
      router.push(`/room/${code}`);
    }
  };

  if (checking) {
    return (
      <div className="min-h-dvh flex items-center justify-center select-none">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-4 select-none">
      <div className="max-w-md w-full text-center space-y-8 lg:max-w-lg lg:bg-bg-card/50 lg:backdrop-blur-xl lg:border lg:border-white/[0.06] lg:rounded-3xl lg:p-10 lg:shadow-[0_8px_32px_rgba(0,0,0,0.3)]">
        {/* Logo / Brand */}
        <div className="space-y-2">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-accent/10 mb-4 lg:w-20 lg:h-20 lg:rounded-3xl">
            <svg className="w-8 h-8 text-accent lg:w-10 lg:h-10" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
            </svg>
          </div>
          <h1 className="text-4xl font-bold tracking-tight lg:text-5xl">PartyQueue</h1>
          <p className="text-text-secondary text-lg lg:text-xl">
            Your crowd. Your queue.
          </p>
        </div>

        {/* Rejoin active room */}
        {lastRoom && (
          <div className="space-y-3">
            <button
              onClick={() => router.push(`/room/${lastRoom.code}`)}
              className="w-full py-3.5 bg-accent hover:bg-accent-hover text-black font-semibold rounded-xl transition-colors"
            >
              Rejoin {lastRoom.roomName}
            </button>
            <p className="text-text-secondary text-xs">
              Room {lastRoom.code} is still active
            </p>
          </div>
        )}

        {/* Join Room */}
        <form onSubmit={handleJoin} className="space-y-4">
          {lastRoom && (
            <div className="flex items-center gap-4">
              <div className="flex-1 h-px bg-border" />
              <span className="text-text-secondary text-sm">or join a different room</span>
              <div className="flex-1 h-px bg-border" />
            </div>
          )}
          <div className="space-y-2">
            {!lastRoom && (
              <label htmlFor="roomCode" className="block text-sm font-medium text-text-secondary">
                Enter Room Code
              </label>
            )}
            <input
              id="roomCode"
              type="text"
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
              placeholder="e.g. ABC123"
              maxLength={8}
              className="w-full px-4 py-3 bg-bg-card border border-border rounded-xl text-center text-xl font-mono tracking-widest placeholder:text-text-secondary/40 focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </div>
          <button
            type="submit"
            disabled={roomCode.trim().length < 4}
            className={`w-full py-3 font-semibold rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              lastRoom
                ? "bg-bg-card hover:bg-bg-card-hover border border-border"
                : "bg-accent hover:bg-accent-hover text-black"
            }`}
          >
            Join Room
          </button>
        </form>

        {/* Host CTA */}
        {!lastRoom && (
          <>
            <div className="flex items-center gap-4">
              <div className="flex-1 h-px bg-border" />
              <span className="text-text-secondary text-sm">or</span>
              <div className="flex-1 h-px bg-border" />
            </div>
            <div className="space-y-3">
              <p className="text-text-secondary text-sm">
                Want to host? Create a room and let your crowd decide the vibe.
              </p>
              <a
                href="/dashboard"
                className="inline-block w-full py-3 bg-bg-card hover:bg-bg-card-hover border border-border rounded-xl font-medium transition-colors"
              >
                Host a Room
              </a>
            </div>
          </>
        )}
      </div>
      <p className="hidden lg:block fixed bottom-6 left-1/2 -translate-x-1/2 text-white/15 text-xs tracking-wide">partyqueue.com</p>
    </div>
  );
}
