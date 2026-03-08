"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";

interface Song {
  id: string;
  trackName: string;
  artistName: string;
  albumArt: string | null;
  isPlaying: boolean;
  isPlayed: boolean;
  upvotes: number;
  downvotes: number;
}

interface RoomData {
  id: string;
  code: string;
  name: string;
  brandName: string;
  brandColor: string;
  songs: Song[];
  guests?: { length: number };
  _guestCount?: number;
}

export default function DisplayPage() {
  const params = useParams();
  const code = params.code as string;
  const [room, setRoom] = useState<RoomData | null>(null);
  const [guestCount, setGuestCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [cursorHidden, setCursorHidden] = useState(false);
  const cursorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchRoom = useCallback(async () => {
    try {
      const [roomRes, guestRes] = await Promise.all([
        fetch(`/api/rooms/${code}`),
        fetch(`/api/rooms/${code}/guests`).catch(() => null),
      ]);
      if (!roomRes.ok) {
        const data = await roomRes.json();
        setError(data.error || "Room not found");
        return;
      }
      const data = await roomRes.json();
      setRoom(data);
      setError(null);

      if (guestRes?.ok) {
        const guests = await guestRes.json();
        setGuestCount(Array.isArray(guests) ? guests.length : 0);
      }
    } catch {
      setError("Failed to connect");
    }
  }, [code]);

  // Poll room data every 5 seconds
  useEffect(() => {
    fetchRoom();
    const interval = setInterval(fetchRoom, 5000);
    return () => clearInterval(interval);
  }, [fetchRoom]);

  // Auto-hide cursor after 3 seconds of no movement
  useEffect(() => {
    const handleMouseMove = () => {
      setCursorHidden(false);
      if (cursorTimer.current) clearTimeout(cursorTimer.current);
      cursorTimer.current = setTimeout(() => setCursorHidden(true), 3000);
    };
    window.addEventListener("mousemove", handleMouseMove);
    // Start the timer immediately
    cursorTimer.current = setTimeout(() => setCursorHidden(true), 3000);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      if (cursorTimer.current) clearTimeout(cursorTimer.current);
    };
  }, []);

  if (error) {
    return (
      <div className="min-h-screen bg-bg-primary flex items-center justify-center">
        <p className="text-text-secondary text-2xl">{error}</p>
      </div>
    );
  }

  if (!room) {
    return (
      <div className="min-h-screen bg-bg-primary flex items-center justify-center">
        <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const nowPlaying = room.songs.find((s) => s.isPlaying);
  const upNext = room.songs
    .filter((s) => !s.isPlaying && !s.isPlayed)
    .slice(0, 5);
  const roomUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/room/${code}`;
  const displayName = room.brandName || room.name;
  const accentColor = room.brandColor || "#1db954";

  return (
    <div
      className="min-h-screen bg-bg-primary overflow-hidden select-none"
      style={{ cursor: cursorHidden ? "none" : "auto" }}
    >
      {/* Ambient background glow */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          background: `radial-gradient(ellipse at 35% 50%, ${accentColor}08 0%, transparent 60%), radial-gradient(ellipse at 65% 30%, ${accentColor}05 0%, transparent 50%)`,
        }}
      />

      {/* Main layout */}
      <div className="relative z-10 min-h-screen flex flex-col p-6 md:p-10 lg:p-12">
        {/* Top bar: Room name + guest count */}
        <div className="flex items-center justify-between mb-6 md:mb-10">
          <h1 className="text-xl md:text-2xl lg:text-3xl font-bold text-text-primary truncate">
            {displayName}
          </h1>
          {guestCount > 0 && (
            <div className="flex items-center gap-2 text-text-secondary text-sm md:text-base ml-4 shrink-0">
              <svg className="w-4 h-4 md:w-5 md:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <span>{guestCount}</span>
            </div>
          )}
        </div>

        {/* Content: two-column on large screens, stacked on small */}
        <div className="flex-1 flex flex-col lg:flex-row items-center lg:items-start gap-8 lg:gap-12">
          {/* Left: Now Playing */}
          <div className="flex-1 flex flex-col items-center justify-center w-full lg:w-auto">
            {nowPlaying ? (
              <>
                {/* Album art with ambient glow */}
                <div className="relative mb-6 md:mb-8">
                  {/* Glow behind album art */}
                  {nowPlaying.albumArt && (
                    <div
                      className="absolute inset-0 rounded-2xl blur-3xl opacity-30 scale-110"
                      style={{
                        backgroundImage: `url(${nowPlaying.albumArt})`,
                        backgroundSize: "cover",
                        backgroundPosition: "center",
                      }}
                    />
                  )}
                  {nowPlaying.albumArt ? (
                    <img
                      src={nowPlaying.albumArt}
                      alt={nowPlaying.trackName}
                      className="relative w-64 h-64 md:w-80 md:h-80 lg:w-96 lg:h-96 rounded-2xl shadow-2xl now-playing object-cover"
                    />
                  ) : (
                    <div className="relative w-64 h-64 md:w-80 md:h-80 lg:w-96 lg:h-96 rounded-2xl bg-bg-card flex items-center justify-center now-playing">
                      <svg className="w-20 h-20 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                      </svg>
                    </div>
                  )}
                </div>

                {/* Song info */}
                <div className="text-center max-w-lg">
                  <p className="text-xs md:text-sm font-medium uppercase tracking-widest mb-2 md:mb-3" style={{ color: accentColor }}>
                    Now Playing
                  </p>
                  <h2 className="text-2xl md:text-3xl lg:text-4xl font-bold text-text-primary leading-tight mb-2">
                    {nowPlaying.trackName}
                  </h2>
                  <p className="text-lg md:text-xl lg:text-2xl text-text-secondary">
                    {nowPlaying.artistName}
                  </p>
                </div>
              </>
            ) : (
              <div className="text-center">
                <div className="w-64 h-64 md:w-80 md:h-80 lg:w-96 lg:h-96 rounded-2xl bg-bg-card flex items-center justify-center mb-6">
                  <svg className="w-20 h-20 text-text-secondary opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <p className="text-xl text-text-secondary">Waiting for music...</p>
              </div>
            )}
          </div>

          {/* Right: QR code + Up Next */}
          <div className="w-full lg:w-80 xl:w-96 flex flex-col items-center lg:items-start gap-8 shrink-0">
            {/* QR Code Card */}
            <div className="bg-bg-card/60 border border-border rounded-2xl p-6 md:p-8 flex flex-col items-center w-full max-w-sm lg:max-w-none backdrop-blur-sm">
              <p className="text-text-secondary text-xs md:text-sm font-medium uppercase tracking-wider mb-4">
                Scan to Vote
              </p>
              <div className="bg-white rounded-xl p-3 md:p-4 mb-4">
                <QRCodeSVG
                  value={roomUrl}
                  size={140}
                  bgColor="#ffffff"
                  fgColor="#000000"
                  level="M"
                />
              </div>
              <p className="font-mono text-3xl md:text-4xl font-bold tracking-wider" style={{ color: accentColor }}>
                {room.code}
              </p>
              <p className="text-text-secondary text-xs mt-1">crowddj.vercel.app</p>
            </div>

            {/* Up Next */}
            {upNext.length > 0 && (
              <div className="w-full max-w-sm lg:max-w-none">
                <p className="text-text-secondary text-xs md:text-sm font-medium uppercase tracking-wider mb-3">
                  Up Next
                </p>
                <div className="flex flex-col gap-2">
                  {upNext.map((song, i) => (
                    <div
                      key={song.id}
                      className="flex items-center gap-3 bg-bg-card/40 border border-border/50 rounded-xl px-4 py-3 transition-opacity"
                      style={{ opacity: 1 - i * 0.12 }}
                    >
                      {song.albumArt && (
                        <img
                          src={song.albumArt}
                          alt=""
                          className="w-10 h-10 rounded-lg object-cover shrink-0"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm md:text-base font-medium text-text-primary truncate">
                          {song.trackName}
                        </p>
                        <p className="text-xs md:text-sm text-text-secondary truncate">
                          {song.artistName}
                        </p>
                      </div>
                      <div className="text-xs font-medium shrink-0" style={{ color: accentColor }}>
                        {song.upvotes - song.downvotes > 0 ? "+" : ""}
                        {song.upvotes - song.downvotes}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
