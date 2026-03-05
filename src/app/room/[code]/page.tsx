"use client";

import { useState, useEffect, useCallback, useRef, use } from "react";
import { getFingerprint } from "@/lib/fingerprint";

type Song = {
  id: string;
  trackName: string;
  artistName: string;
  albumArt: string | null;
  durationMs: number;
  upvotes: number;
  downvotes: number;
  isPlaying: boolean;
  netScore: number;
  votes: { guestId: string; value: number }[];
};

type Room = {
  id: string;
  code: string;
  name: string;
  playlistName: string;
  votesPerUser: number;
  voteResetMinutes: number;
  host: { name: string; image: string | null };
};

export default function RoomPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const [room, setRoom] = useState<Room | null>(null);
  const [songs, setSongs] = useState<Song[]>([]);
  const [fingerprint, setFingerprint] = useState("");
  const [guestId, setGuestId] = useState("");
  const [votesUsed, setVotesUsed] = useState(0);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [requestStatus, setRequestStatus] = useState("");
  const lastInteraction = useRef(0);
  const pendingSongs = useRef<Song[] | null>(null);

  const fetchSongs = useCallback(async () => {
    const res = await fetch(`/api/rooms/${code}/songs`);
    if (res.ok) {
      const data = await res.json();
      // If user interacted recently, queue the update for later
      if (Date.now() - lastInteraction.current < 3000) {
        pendingSongs.current = data;
      } else {
        setSongs(data);
        pendingSongs.current = null;
      }
    }
  }, [code]);

  const fetchRoom = useCallback(async () => {
    const res = await fetch(`/api/rooms/${code}`);
    if (res.ok) {
      const data = await res.json();
      setRoom(data);
      setSongs(
        data.songs.map((s: any) => ({ ...s, netScore: s.upvotes - s.downvotes, votes: s.votes || [] }))
      );
    } else {
      const err = await res.json();
      setError(err.error || "Room not found");
    }
  }, [code]);

  useEffect(() => {
    fetchRoom();
    getFingerprint().then(async (fp) => {
      setFingerprint(fp);
      // Fetch guest record to restore guestId and votesUsed
      const res = await fetch(`/api/rooms/${code}/guest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fingerprint: fp }),
      });
      if (res.ok) {
        const data = await res.json();
        setGuestId(data.guestId);
        setVotesUsed(data.votesUsed);
      }
    });

    const interval = setInterval(() => {
      fetch(`/api/rooms/${code}/sync`, { method: "POST" });
      fetchSongs();
    }, 5000);

    // Flush pending song data once the user stops interacting
    const flushInterval = setInterval(() => {
      if (pendingSongs.current && Date.now() - lastInteraction.current >= 3000) {
        setSongs(pendingSongs.current);
        pendingSongs.current = null;
      }
    }, 1000);

    return () => {
      clearInterval(interval);
      clearInterval(flushInterval);
    };
  }, [code, fetchRoom, fetchSongs]);

  const vote = async (songId: string, value: 1 | -1) => {
    if (!fingerprint) return;

    lastInteraction.current = Date.now();

    // Check if there's an opposite vote to undo
    const song = songs.find((s) => s.id === songId);
    const myVotes = song?.votes?.filter((v) => v.guestId === guestId) || [];
    const oppositeValue = value === 1 ? -1 : 1;
    const hasOpposite = myVotes.some((v) => v.value === oppositeValue);

    if (!hasOpposite && votesUsed >= (room?.votesPerUser ?? 5)) {
      setRequestStatus("Out of votes! They'll reset soon.");
      setTimeout(() => setRequestStatus(""), 3000);
      return;
    }

    // Optimistic update
    setSongs((prev) => {
      const updated = prev.map((s) => {
        if (s.id !== songId) return s;

        const myVotesOnSong = (s.votes || []).filter((v) => v.guestId === guestId);
        const oppositeVote = myVotesOnSong.find((v) => v.value === oppositeValue);

        if (oppositeVote) {
          // Undo one opposite vote — remove it, refund
          const newVotes = [...(s.votes || [])];
          const idx = newVotes.findIndex(
            (v) => v.guestId === guestId && v.value === oppositeValue
          );
          newVotes.splice(idx, 1);

          return {
            ...s,
            upvotes: s.upvotes - (oppositeValue === 1 ? 1 : 0),
            downvotes: s.downvotes - (oppositeValue === -1 ? 1 : 0),
            netScore: s.netScore - oppositeValue,
            votes: newVotes,
          };
        } else {
          // New vote
          return {
            ...s,
            upvotes: s.upvotes + (value === 1 ? 1 : 0),
            downvotes: s.downvotes + (value === -1 ? 1 : 0),
            netScore: s.netScore + value,
            votes: [...(s.votes || []), { guestId, value }],
          };
        }
      });

      // Don't re-sort — keep the list stable while the user is voting.
      // The poll flush will reorder once they stop interacting.
      return updated;
    });

    // Update vote count optimistically
    if (hasOpposite) {
      setVotesUsed((v) => Math.max(0, v - 1));
    } else {
      setVotesUsed((v) => Math.min(v + 1, room?.votesPerUser ?? 5));
    }

    // Fire the API call
    const res = await fetch(`/api/rooms/${code}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ songId, value, fingerprint }),
    });

    if (!res.ok) {
      fetchSongs();
      if (hasOpposite) {
        setVotesUsed((v) => v + 1);
      } else {
        setVotesUsed((v) => Math.max(0, v - 1));
      }
      if (res.status === 429) {
        setRequestStatus("Out of votes! They'll reset soon.");
        setTimeout(() => setRequestStatus(""), 3000);
      }
    }
  };

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const searchSongs = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    const res = await fetch(
      `/api/rooms/${code}/search?q=${encodeURIComponent(query)}`
    );
    if (res.ok) {
      setSearchResults(await res.json());
    }
    setSearching(false);
  }, [code]);

  const onSearchChange = (value: string) => {
    setSearchQuery(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!value.trim()) {
      setSearchResults([]);
      return;
    }
    searchTimer.current = setTimeout(() => searchSongs(value), 300);
  };

  const requestSong = async (track: any) => {
    const res = await fetch(`/api/rooms/${code}/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...track, fingerprint }),
    });

    const data = await res.json();
    if (res.ok) {
      setRequestStatus(
        data.status === "pending" ? "Request sent! Waiting for host approval." : "Song added to queue!"
      );
      setShowSearch(false);
      setSearchQuery("");
      setSearchResults([]);
    } else {
      setRequestStatus(data.error || "Failed to request song");
    }
    setTimeout(() => setRequestStatus(""), 3000);
  };

  const formatDuration = (ms: number) => {
    const min = Math.floor(ms / 60000);
    const sec = Math.floor((ms % 60000) / 1000);
    return `${min}:${sec.toString().padStart(2, "0")}`;
  };

  if (error) {
    return (
      <div className="min-h-dvh flex items-center justify-center px-4">
        <div className="text-center space-y-4">
          <p className="text-2xl font-bold text-downvote">{error}</p>
          <a href="/" className="text-accent hover:text-accent-hover transition-colors">
            Go home
          </a>
        </div>
      </div>
    );
  }

  if (!room) {
    return (
      <div className="min-h-dvh flex items-center justify-center">
        <div className="text-text-secondary">Loading room...</div>
      </div>
    );
  }

  const votesRemaining = Math.max(0, room.votesPerUser - votesUsed);
  const outOfVotes = votesRemaining === 0;

  return (
    <div className="min-h-dvh flex flex-col max-w-lg mx-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-bg-primary/80 backdrop-blur-xl border-b border-border px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="min-w-0 flex-1">
            <h1 className="font-bold text-lg truncate">{room.name}</h1>
            <p className="text-text-secondary text-xs">
              Hosted by {room.host.name} &middot; {room.code}
            </p>
          </div>
          <button
            onClick={() => setShowSearch(!showSearch)}
            className="ml-3 p-2.5 bg-accent/10 text-accent rounded-xl hover:bg-accent/20 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>

        {/* Votes remaining badge */}
        <div className="mt-2 flex items-center gap-2">
          <div className="flex gap-1">
            {Array.from({ length: room.votesPerUser }).map((_, i) => (
              <div
                key={i}
                className={`w-2 h-2 rounded-full ${
                  i < votesRemaining ? "bg-accent" : "bg-border"
                }`}
              />
            ))}
          </div>
          {outOfVotes ? (
            <span className="text-downvote text-xs font-medium">
              Out of votes &middot; resets every {room.voteResetMinutes}min
            </span>
          ) : (
            <span className="text-text-secondary text-xs">
              {votesRemaining} vote{votesRemaining !== 1 ? "s" : ""} left
            </span>
          )}
        </div>
      </div>

      {/* Status toast */}
      {requestStatus && (
        <div className="mx-4 mt-3 px-4 py-2.5 bg-bg-card border border-accent/30 rounded-xl text-sm text-center">
          {requestStatus}
        </div>
      )}

      {/* Search overlay */}
      {showSearch && (
        <div className="px-4 py-3 bg-bg-secondary border-b border-border">
          <div className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search for a song..."
              className="w-full px-3 py-2.5 bg-bg-card border border-border rounded-xl text-sm focus:outline-none focus:border-accent pr-10"
              autoFocus
            />
            {searching && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary text-xs">
                ...
              </div>
            )}
          </div>
          {searchResults.length > 0 && (
            <div className="mt-2 max-h-60 overflow-y-auto space-y-1">
              {searchResults.map((track: any) => (
                <button
                  key={track.spotifyUri}
                  onClick={() => requestSong(track)}
                  className="w-full flex items-center gap-3 p-2.5 bg-bg-card hover:bg-bg-card-hover rounded-xl text-left transition-colors"
                >
                  {track.albumArt && (
                    <img src={track.albumArt} alt="" className="w-10 h-10 rounded-lg" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{track.trackName}</p>
                    <p className="text-text-secondary text-xs truncate">{track.artistName}</p>
                  </div>
                  <span className="text-accent text-xs font-medium">Add</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Song List */}
      <div className="flex-1 px-4 py-3 space-y-2 pb-20">
        {songs.map((song, i) => {
          const myVotes = song.votes?.filter((v) => v.guestId === guestId) || [];
          const myUpvotes = myVotes.filter((v) => v.value === 1).length;
          const myDownvotes = myVotes.filter((v) => v.value === -1).length;

          return (
            <div
              key={song.id}
              className={`song-card flex items-center gap-3 p-3 rounded-xl border ${
                song.isPlaying
                  ? "bg-accent/5 border-accent now-playing"
                  : "bg-bg-card border-border"
              }`}
            >
              {/* Position / Playing indicator */}
              <div className="w-6 text-center flex-shrink-0">
                {song.isPlaying ? (
                  <div className="flex items-center justify-center gap-0.5">
                    <span className="w-0.5 h-3 bg-accent rounded-full animate-pulse" />
                    <span className="w-0.5 h-4 bg-accent rounded-full animate-pulse [animation-delay:0.2s]" />
                    <span className="w-0.5 h-2 bg-accent rounded-full animate-pulse [animation-delay:0.4s]" />
                  </div>
                ) : (
                  <span className="text-text-secondary text-sm">{i + 1}</span>
                )}
              </div>

              {/* Album art */}
              {song.albumArt && (
                <img src={song.albumArt} alt="" className="w-11 h-11 rounded-lg flex-shrink-0" />
              )}

              {/* Song info */}
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm truncate">{song.trackName}</p>
                <p className="text-text-secondary text-xs truncate">{song.artistName}</p>
              </div>

              {/* Vote buttons */}
              {!song.isPlaying && (
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => vote(song.id, 1)}
                    className={`vote-btn p-2 rounded-lg hover:bg-upvote/10 relative ${
                      myUpvotes > 0 ? "bg-upvote/10" : ""
                    }`}
                  >
                    <svg
                      className={`w-4 h-4 ${
                        myUpvotes > 0 ? "text-upvote" : "text-text-secondary"
                      }`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                    </svg>
                    {myUpvotes > 1 && (
                      <span className="absolute -top-1 -right-1 w-4 h-4 bg-upvote text-black text-[10px] font-bold rounded-full flex items-center justify-center">
                        {myUpvotes}
                      </span>
                    )}
                  </button>

                  <span
                    className={`text-sm font-medium min-w-[1.5rem] text-center ${
                      song.netScore > 0
                        ? "text-upvote"
                        : song.netScore < 0
                        ? "text-downvote"
                        : "text-text-secondary"
                    }`}
                  >
                    {song.netScore}
                  </span>

                  <button
                    onClick={() => vote(song.id, -1)}
                    className={`vote-btn p-2 rounded-lg hover:bg-downvote/10 relative ${
                      myDownvotes > 0 ? "bg-downvote/10" : ""
                    }`}
                  >
                    <svg
                      className={`w-4 h-4 ${
                        myDownvotes > 0 ? "text-downvote" : "text-text-secondary"
                      }`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                    {myDownvotes > 1 && (
                      <span className="absolute -top-1 -right-1 w-4 h-4 bg-downvote text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                        {myDownvotes}
                      </span>
                    )}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
