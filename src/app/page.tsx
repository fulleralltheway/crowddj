"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const [roomCode, setRoomCode] = useState("");
  const router = useRouter();

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    const code = roomCode.trim().toUpperCase();
    if (code.length >= 4) {
      router.push(`/room/${code}`);
    }
  };

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-4">
      <div className="max-w-md w-full text-center space-y-8">
        {/* Logo / Brand */}
        <div className="space-y-2">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-accent/10 mb-4">
            <svg className="w-8 h-8 text-accent" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
            </svg>
          </div>
          <h1 className="text-4xl font-bold tracking-tight">CrowdDJ</h1>
          <p className="text-text-secondary text-lg">
            Your crowd controls the music
          </p>
        </div>

        {/* Join Room */}
        <form onSubmit={handleJoin} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="roomCode" className="block text-sm font-medium text-text-secondary">
              Enter Room Code
            </label>
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
            className="w-full py-3 bg-accent hover:bg-accent-hover text-black font-semibold rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Join Room
          </button>
        </form>

        {/* Divider */}
        <div className="flex items-center gap-4">
          <div className="flex-1 h-px bg-border" />
          <span className="text-text-secondary text-sm">or</span>
          <div className="flex-1 h-px bg-border" />
        </div>

        {/* Host CTA */}
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
      </div>
    </div>
  );
}
