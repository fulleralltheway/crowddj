"use client";

import { useState, useEffect, useCallback, useRef, use } from "react";
import { getFingerprint } from "@/lib/fingerprint";

type Song = {
  id: string;
  spotifyUri: string;
  trackName: string;
  artistName: string;
  albumArt: string | null;
  durationMs: number;
  upvotes: number;
  downvotes: number;
  isPlaying: boolean;
  isLocked: boolean;
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
  votingPaused: boolean;
  host: { name: string; image: string | null };
};

export default function RoomPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const [room, setRoom] = useState<Room | null>(null);
  const [songs, setSongs] = useState<Song[]>([]);
  const [fingerprint, setFingerprint] = useState("");
  const [guestId, setGuestId] = useState("");
  const [guestName, setGuestName] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [nameSubmitted, setNameSubmitted] = useState(false);
  const [votesUsed, setVotesUsed] = useState(0);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [requestStatus, setRequestStatus] = useState("");
  const [lastVoteReset, setLastVoteReset] = useState<number>(Date.now());
  const [resetCountdown, setResetCountdown] = useState("");
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const lastInteraction = useRef(0);
  const pendingSongs = useRef<Song[] | null>(null);
  const knownApproved = useRef<Set<string>>(new Set());

  const fetchSongs = useCallback(async () => {
    const res = await fetch(`/api/rooms/${code}/songs`);
    if (res.ok) {
      const data = await res.json();
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
      // Check if this guest already has a name (returning visitor)
      const res = await fetch(`/api/rooms/${code}/guest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fingerprint: fp }),
      });
      if (res.ok) {
        const data = await res.json();
        setGuestId(data.guestId);
        setVotesUsed(data.votesUsed);
        setLastVoteReset(new Date(data.lastVoteReset).getTime());
        if (data.name) {
          setGuestName(data.name);
          setNameSubmitted(true);
        }
      }
    });

    const interval = setInterval(() => {
      fetch(`/api/rooms/${code}/sync`, { method: "POST" });
      fetchSongs();
    }, 5000);

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

  // Poll for request approvals to send notifications
  useEffect(() => {
    if (!notificationsEnabled || !fingerprint) return;
    const checkRequests = async () => {
      const res = await fetch(`/api/rooms/${code}/my-requests?fingerprint=${encodeURIComponent(fingerprint)}`);
      if (!res.ok) return;
      const reqs = await res.json();
      for (const r of reqs) {
        if (r.status === "approved" && !knownApproved.current.has(r.id)) {
          knownApproved.current.add(r.id);
          // Don't notify on first load
          if (knownApproved.current.size > 1 || reqs.filter((x: any) => x.status === "approved").length === 1) {
            new Notification("Song Approved!", {
              body: `"${r.trackName}" by ${r.artistName} was added to the queue`,
              icon: r.albumArt || undefined,
            });
          }
        }
      }
      // Seed known approved on first load
      if (knownApproved.current.size === 0) {
        for (const r of reqs) {
          if (r.status === "approved") knownApproved.current.add(r.id);
        }
      }
    };
    checkRequests();
    const interval = setInterval(checkRequests, 10000);
    return () => clearInterval(interval);
  }, [code, fingerprint, notificationsEnabled]);

  // Countdown timer for vote reset
  useEffect(() => {
    if (!room) return;
    const tick = () => {
      const resetMs = room.voteResetMinutes * 60 * 1000;
      const resetAt = lastVoteReset + resetMs;
      const remaining = resetAt - Date.now();
      if (remaining <= 0) {
        setResetCountdown("");
        setVotesUsed(0);
        setLastVoteReset(Date.now());
      } else {
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        setResetCountdown(`${mins}:${secs.toString().padStart(2, "0")}`);
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [room, lastVoteReset]);

  const vote = async (songId: string, value: 1 | -1) => {
    if (!fingerprint) return;
    if (room?.votingPaused) {
      setRequestStatus("Voting is paused by the DJ");
      setTimeout(() => setRequestStatus(""), 3000);
      return;
    }

    lastInteraction.current = Date.now();

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
          return {
            ...s,
            upvotes: s.upvotes + (value === 1 ? 1 : 0),
            downvotes: s.downvotes + (value === -1 ? 1 : 0),
            netScore: s.netScore + value,
            votes: [...(s.votes || []), { guestId, value }],
          };
        }
      });

      return updated;
    });

    if (hasOpposite) {
      setVotesUsed((v) => Math.max(0, v - 1));
    } else {
      setVotesUsed((v) => Math.min(v + 1, room?.votesPerUser ?? 5));
    }

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
      // Refresh songs so the newly added song appears in queue matches
      const songsRes = await fetch(`/api/rooms/${code}/songs`);
      if (songsRes.ok) setSongs(await songsRes.json());
      // Remove it from Spotify results so it shows in queue section instead
      setSearchResults((prev) => prev.filter((t: any) => t.spotifyUri !== track.spotifyUri));
      setSearchResults([]);
    } else {
      setRequestStatus(data.error || "Failed to request song");
    }
    setTimeout(() => setRequestStatus(""), 3000);
  };

  if (error) {
    const isClosed = error.includes("closed") || error.includes("expired");
    return (
      <div className="min-h-dvh flex items-center justify-center px-4">
        <div className="text-center space-y-4">
          <div className="text-4xl mb-2">{isClosed ? "\u{1F3B5}" : "\u{1F50D}"}</div>
          <p className="text-2xl font-bold">{isClosed ? "Party's Over" : error}</p>
          {isClosed && (
            <p className="text-text-secondary">This room has been closed by the host.</p>
          )}
          <a href="/" className="inline-block mt-2 px-6 py-2.5 bg-accent hover:bg-accent-hover text-black font-semibold rounded-xl transition-colors">
            Back to Home
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

  const submitName = async () => {
    const trimmed = nameInput.trim();
    if (!trimmed) return;
    setGuestName(trimmed);
    setNameSubmitted(true);
    // Re-register guest with name
    if (fingerprint) {
      const res = await fetch(`/api/rooms/${code}/guest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fingerprint, name: trimmed }),
      });
      if (res.ok) {
        const data = await res.json();
        setGuestId(data.guestId);
      }
    }
  };

  if (!nameSubmitted) {
    return (
      <div className="min-h-dvh flex items-center justify-center px-4">
        <div className="w-full max-w-sm text-center space-y-6">
          <div>
            <h1 className="text-2xl font-bold mb-1">{room.name}</h1>
            <p className="text-text-secondary text-sm">Hosted by {room.host.name}</p>
          </div>
          <div className="space-y-3">
            <p className="text-lg font-medium">What's your name?</p>
            <input
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitName()}
              placeholder="Enter your name"
              autoFocus
              maxLength={30}
              className="w-full px-4 py-3 bg-bg-card border border-border rounded-xl text-center text-lg focus:outline-none focus:border-accent"
            />
            <button
              onClick={submitName}
              disabled={!nameInput.trim()}
              className="w-full py-3 bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold rounded-xl transition-colors"
            >
              Join Room
            </button>
          </div>
        </div>
      </div>
    );
  }

  const votesRemaining = Math.max(0, room.votesPerUser - votesUsed);
  const outOfVotes = votesRemaining === 0;
  const nowPlaying = songs.find((s) => s.isPlaying);
  return (
    <div className="min-h-dvh flex flex-col max-w-lg mx-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-bg-primary/80 backdrop-blur-xl border-b border-border px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <div className="min-w-0 flex-1">
            <h1 className="font-bold text-lg truncate">{room.name}</h1>
            <p className="text-text-secondary text-xs">
              Hosted by {room.host.name} &middot; {room.code}
            </p>
          </div>
          {/* Notification bell + Votes remaining */}
          <div className="ml-3 flex-shrink-0 flex items-center gap-2">
            <button
              onClick={async () => {
                if (notificationsEnabled) {
                  setNotificationsEnabled(false);
                } else if ("Notification" in window) {
                  const perm = await Notification.requestPermission();
                  setNotificationsEnabled(perm === "granted");
                }
              }}
              className={`p-1.5 rounded-lg transition-colors ${
                notificationsEnabled
                  ? "text-accent bg-accent/15"
                  : "text-text-secondary hover:text-white"
              }`}
              title={notificationsEnabled ? "Notifications on" : "Enable notifications"}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
            </button>
          <div>
            {room.votingPaused ? (
              <span className="px-2.5 py-0.5 bg-yellow-500/15 text-yellow-500 text-xs font-semibold rounded-full">
                Paused
              </span>
            ) : outOfVotes ? (
              <div className="text-right">
                <span className="px-2.5 py-0.5 bg-downvote/15 text-downvote text-xs font-semibold rounded-full">
                  0 / {room.votesPerUser}
                </span>
                {resetCountdown && (
                  <p className="text-text-secondary text-[10px] mt-0.5">{resetCountdown}</p>
                )}
              </div>
            ) : (
              <div className="text-right">
                <span className="px-2.5 py-0.5 bg-accent/15 text-accent text-xs font-semibold rounded-full">
                  {votesRemaining} / {room.votesPerUser}
                </span>
                {resetCountdown && (
                  <p className="text-text-secondary text-[10px] mt-0.5">{resetCountdown}</p>
                )}
              </div>
            )}
          </div>
          </div>
        </div>

        {/* Persistent search bar */}
        <div className="relative">
          <svg className="w-4 h-4 text-text-secondary absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => {
              onSearchChange(e.target.value);
              if (e.target.value.trim()) setShowSearch(true);
            }}
            onFocus={() => { if (searchQuery.trim()) setShowSearch(true); }}
            placeholder="Search or add songs..."
            className="w-full pl-9 pr-9 py-2 bg-bg-card border border-border rounded-xl text-sm focus:outline-none focus:border-accent"
          />
          {(searchQuery || showSearch) && (
            <button
              onClick={() => {
                setSearchQuery("");
                setSearchResults([]);
                setShowSearch(false);
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-secondary hover:text-white transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
          {searching && !searchQuery && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary text-xs">...</div>
          )}
        </div>
      </div>

      {/* Status toast */}
      {requestStatus && (
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none px-8">
          <div className="px-6 py-4 bg-bg-card border border-accent/30 rounded-2xl text-sm text-center shadow-lg backdrop-blur-sm pointer-events-auto">
            {requestStatus}
          </div>
        </div>
      )}

      {/* Search results dropdown */}
      {showSearch && searchQuery.trim() && (() => {
        const q = searchQuery.trim().toLowerCase();
        const queueMatches = songs.filter(
          (s) =>
            !s.isPlaying &&
            (s.trackName.toLowerCase().includes(q) ||
              s.artistName.toLowerCase().includes(q))
        );
        // Filter Spotify results to exclude songs already in queue
        const filteredSpotify = searchResults.filter(
          (track: any) => !songs.some((s) => s.spotifyUri === track.spotifyUri)
        );

        if (queueMatches.length === 0 && filteredSpotify.length === 0 && !searching) return null;

        return (
          <div className="mx-4 mt-2 bg-bg-card border border-border rounded-xl overflow-hidden shadow-lg">
            <div className="max-h-72 overflow-y-auto divide-y divide-border/50">
              {queueMatches.length > 0 && (
                <div className="p-2 space-y-1">
                  <p className="text-text-secondary text-[10px] font-semibold uppercase tracking-wider px-1">In Queue</p>
                  {queueMatches.map((song) => {
                    const myVotes = song.votes?.filter((v) => v.guestId === guestId) || [];
                    const myUp = myVotes.filter((v) => v.value === 1).length;
                    const myDown = myVotes.filter((v) => v.value === -1).length;

                    return (
                      <div
                        key={song.id}
                        className="flex items-center gap-3 p-2 rounded-lg"
                      >
                        {song.albumArt && (
                          <img src={song.albumArt} alt="" className="w-9 h-9 rounded-md" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{song.trackName}</p>
                          <p className="text-text-secondary text-xs truncate">{song.artistName}</p>
                        </div>
                        {!song.isLocked && (
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              onClick={() => vote(song.id, 1)}
                              className={`p-1.5 rounded-lg hover:bg-upvote/10 ${myUp > 0 ? "bg-upvote/10" : ""}`}
                            >
                              <svg className={`w-4 h-4 ${myUp > 0 ? "text-upvote" : "text-text-secondary"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                              </svg>
                            </button>
                            <span className={`text-xs font-medium min-w-[1.2rem] text-center ${song.netScore > 0 ? "text-upvote" : song.netScore < 0 ? "text-downvote" : "text-text-secondary"}`}>
                              {song.netScore}
                            </span>
                            <button
                              onClick={() => vote(song.id, -1)}
                              className={`p-1.5 rounded-lg hover:bg-downvote/10 ${myDown > 0 ? "bg-downvote/10" : ""}`}
                            >
                              <svg className={`w-4 h-4 ${myDown > 0 ? "text-downvote" : "text-text-secondary"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {filteredSpotify.length > 0 && (
                <div className="p-2 space-y-1">
                  <p className="text-text-secondary text-[10px] font-semibold uppercase tracking-wider px-1">Add from Spotify</p>
                  {filteredSpotify.map((track: any) => (
                    <button
                      key={track.spotifyUri}
                      onClick={() => requestSong(track)}
                      className="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-bg-card-hover text-left transition-colors"
                    >
                      {track.albumArt && (
                        <img src={track.albumArt} alt="" className="w-9 h-9 rounded-md" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {track.trackName}
                          {track.isExplicit && (
                            <span className="ml-1 text-[10px] text-text-secondary bg-text-secondary/20 px-1 rounded">E</span>
                          )}
                        </p>
                        <p className="text-text-secondary text-xs truncate">{track.artistName}</p>
                      </div>
                      <span className="text-accent text-xs font-medium">+ Add</span>
                    </button>
                  ))}
                </div>
              )}

              {searching && (
                <div className="p-3 text-center text-text-secondary text-xs">Searching...</div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Now Playing */}
      {nowPlaying && (
        <div className="mx-4 mt-3 p-4 bg-accent/5 border border-accent/30 rounded-xl flex items-center gap-4">
          {nowPlaying.albumArt && (
            <img src={nowPlaying.albumArt} alt="" className="w-14 h-14 rounded-lg shadow-lg" />
          )}
          <div className="flex-1 min-w-0">
            <p className="text-xs text-accent font-medium uppercase tracking-wider">Now Playing</p>
            <p className="font-semibold truncate">{nowPlaying.trackName}</p>
            <p className="text-text-secondary text-sm truncate">{nowPlaying.artistName}</p>
          </div>
          <div className="flex items-center gap-0.5">
            <span className="w-0.5 h-3 bg-accent rounded-full animate-pulse" />
            <span className="w-0.5 h-4 bg-accent rounded-full animate-pulse [animation-delay:0.2s]" />
            <span className="w-0.5 h-2 bg-accent rounded-full animate-pulse [animation-delay:0.4s]" />
          </div>
        </div>
      )}

      {/* Song List */}
      <div className="flex-1 px-4 py-3 space-y-2 pb-8">
        {songs.filter(s => !s.isPlaying).map((song, i) => {
          const myVotes = song.votes?.filter((v) => v.guestId === guestId) || [];
          const myUpvotes = myVotes.filter((v) => v.value === 1).length;
          const myDownvotes = myVotes.filter((v) => v.value === -1).length;

          return (
            <div
              key={song.id}
              className={`song-card flex items-center gap-3 p-3 rounded-xl border ${
                song.isLocked
                  ? "bg-yellow-500/5 border-yellow-500/30"
                  : "bg-bg-card border-border"
              }`}
            >
              <div className="w-6 text-center flex-shrink-0">
                {song.isLocked ? (
                  <span className="text-yellow-500 text-sm">{"\u{1F512}"}</span>
                ) : (
                  <span className="text-text-secondary text-sm">{i + 1}</span>
                )}
              </div>

              {song.albumArt && (
                <img src={song.albumArt} alt="" className="w-11 h-11 rounded-lg flex-shrink-0" />
              )}

              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm truncate">{song.trackName}</p>
                <p className="text-text-secondary text-xs truncate">{song.artistName}</p>
              </div>

              {!song.isLocked && (
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
