"use client";

import { useState, useEffect, useCallback, useRef, use } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { getFingerprint } from "@/lib/fingerprint";
import { getSocket } from "@/lib/socket";
import { useAppHeight, useNetworkStatus } from "@/lib/pwa";

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
  autoShuffle: boolean;
  explicitFilter: boolean;
  requireApproval: boolean;
  maxSongsPerGuest: number;
  lastPreQueuedId: string | null;
  host: { name: string; image: string | null };
};

function getCookie(name: string): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : "";
}

function setCookie(name: string, value: string, days = 365) {
  if (typeof document === "undefined") return;
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)};expires=${expires};path=/;SameSite=Lax`;
}

function getSavedGuestName(code: string): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(`crowddj_name_${code}`)
      || getCookie(`crowddj_name_${code}`)
      || localStorage.getItem("crowddj_name_global")
      || getCookie("crowddj_name_global")
      || "";
  } catch {
    return getCookie(`crowddj_name_${code}`) || getCookie("crowddj_name_global");
  }
}

function saveGuestName(code: string, name: string) {
  try {
    localStorage.setItem(`crowddj_name_${code}`, name);
    localStorage.setItem("crowddj_name_global", name);
  } catch {}
  setCookie(`crowddj_name_${code}`, name);
  setCookie("crowddj_name_global", name);
}

function getSavedGuestId(code: string): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(`crowddj_guestid_${code}`)
      || getCookie(`crowddj_guestid_${code}`)
      || localStorage.getItem("crowddj_guestid_global")
      || getCookie("crowddj_guestid_global")
      || "";
  } catch {
    return getCookie(`crowddj_guestid_${code}`) || getCookie("crowddj_guestid_global");
  }
}

function saveGuestId(code: string, id: string) {
  try {
    localStorage.setItem(`crowddj_guestid_${code}`, id);
    localStorage.setItem("crowddj_guestid_global", id);
  } catch {}
  setCookie(`crowddj_guestid_${code}`, id);
  setCookie("crowddj_guestid_global", id);
}

function saveLastRoom(code: string, roomName: string) {
  try {
    localStorage.setItem("crowddj_last_room", JSON.stringify({ code, roomName }));
  } catch {}
  setCookie("crowddj_last_room", JSON.stringify({ code, roomName }));
}

export default function RoomPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  useAppHeight();
  const isOnline = useNetworkStatus();
  const savedName = getSavedGuestName(code);
  // Single status: "loading" | "need_name" | "welcome" | "ready" — prevents any flash between states
  const [pageStatus, setPageStatus] = useState<"loading" | "need_name" | "welcome" | "ready">(savedName ? "ready" : "loading");
  const [room, setRoom] = useState<Room | null>(null);
  const [songs, setSongs] = useState<Song[]>([]);
  const [fingerprint, setFingerprint] = useState("");
  const [guestId, setGuestId] = useState("");
  const [guestName, setGuestName] = useState(savedName);
  const [nameInput, setNameInput] = useState("");
  const [votesUsed, setVotesUsed] = useState(0);
  const [error, setError] = useState("");
  const [roomClosing, setRoomClosing] = useState(false);
  const [spotifyTrack, setSpotifyTrack] = useState<{ uri: string; name: string; artist: string; albumArt: string | null } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [recentlyRequested, setRecentlyRequested] = useState<Map<string, "added" | "pending">>(new Map());
  const [searching, setSearching] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [requestStatus, setRequestStatus] = useState("");
  const [lastVoteReset, setLastVoteReset] = useState<number>(Date.now());
  const [resetCountdown, setResetCountdown] = useState("");
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [showNotifGuide, setShowNotifGuide] = useState(false);
  const [inAppNotif, setInAppNotif] = useState<{ title: string; body: string; art?: string } | null>(null);
  const lastInteraction = useRef(0); // last vote or scroll activity
  const pendingSongs = useRef<Song[] | null>(null);
  const inFlightVotes = useRef(0);
  const votesUsedRef = useRef(0);
  const serverTimeOffset = useRef(0); // serverTime - localTime, for timer sync
  const postVoteSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reorderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrollTime = useRef(0);
  const [songListRef] = useAutoAnimate({ duration: 300 });
  const knownApproved = useRef<Set<string>>(new Set());
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const pullStartY = useRef(0);
  const pullDistRef = useRef(0);
  const pullRefreshRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const PULL_THRESHOLD = 60;

  const applySongs = useCallback((data: Song[]) => {
    setSongs(data);
    // Derive votesUsed from actual vote data — keeps cross-session in sync
    if (guestId) {
      const count = data.reduce((sum, s) =>
        sum + (s.votes?.filter((v) => v.guestId === guestId).length || 0), 0);
      votesUsedRef.current = count;
      setVotesUsed(count);
    }
  }, [guestId]);

  const isUserBusy = useCallback(() =>
    inFlightVotes.current > 0 ||
    Date.now() - lastInteraction.current < 1500
  , []);

  const fetchSongs = useCallback(async () => {
    const res = await fetch(`/api/rooms/${code}/songs`);
    if (res.ok) {
      const data: Song[] = (await res.json()).map((s: any) => ({
        ...s,
        netScore: s.upvotes - s.downvotes,
        votes: s.votes || [],
      }));
      // Always update now-playing immediately
      const newPlaying = data.find((s: Song) => s.isPlaying);
      setSongs((prev) => {
        const curPlaying = prev.find((s) => s.isPlaying);
        if (newPlaying && curPlaying?.id !== newPlaying.id) {
          const hasIt = prev.some((s) => s.id === newPlaying.id);
          let updated = prev
            .filter((s) => s.id !== curPlaying?.id) // remove old playing song
            .map((s) => ({ ...s, isPlaying: s.id === newPlaying.id }));
          if (!hasIt) updated = [newPlaying, ...updated];
          return updated;
        }
        return prev;
      });
      if (isUserBusy()) {
        pendingSongs.current = data;
      } else {
        applySongs(data);
        pendingSongs.current = null;
      }
    }
  }, [code, applySongs, isUserBusy]);

  useEffect(() => {
    // Run both room fetch and fingerprint check in parallel,
    // only update state once both are done to prevent any flash
    const roomPromise = fetch(`/api/rooms/${code}`).then(async (res) => {
      if (res.ok) return res.json();
      const err = await res.json();
      throw new Error(err.error || "Room not found");
    });

    const storedGuestId = getSavedGuestId(code);
    const storedName = getSavedGuestName(code);
    const guestPromise = getFingerprint().then(async (fp) => {
      setFingerprint(fp);
      const res = await fetch(`/api/rooms/${code}/guest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fingerprint: fp,
          ...(storedGuestId && { guestId: storedGuestId }),
          ...(storedName && { name: storedName }),
        }),
      });
      if (res.ok) return res.json();
      return null;
    }).catch(() => null);

    Promise.all([roomPromise, guestPromise]).then(([roomData, guestData]) => {
      setRoom(roomData);
      setSongs(
        roomData.songs.map((s: any) => ({ ...s, netScore: s.upvotes - s.downvotes, votes: s.votes || [] }))
      );
      if (guestData) {
        setGuestId(guestData.guestId);
        saveGuestId(code, guestData.guestId);
        votesUsedRef.current = guestData.votesUsed;
        setVotesUsed(guestData.votesUsed);
        setLastVoteReset(new Date(guestData.lastVoteReset).getTime());
        if (guestData.name) {
          setGuestName(guestData.name);
          saveGuestName(code, guestData.name);
          // Single state flip: loading → ready (never passes through need_name)
          setPageStatus("ready");
          saveLastRoom(code, roomData.name);
          return;
        }
      }
      // No name found — show name form
      setPageStatus("need_name");
    }).catch((err) => {
      setError(err.message || "Room not found");
      setPageStatus("need_name");
    });

    // Socket.io real-time connection
    const socket = getSocket();
    socket.emit("join-room", code);

    const handleSongsUpdate = (songs: any[]) => {
      const mapped = songs.map((s: any) => ({
        ...s,
        netScore: s.upvotes - s.downvotes,
        votes: s.votes || [],
      }));
      // Always update which song is playing immediately (never defer this)
      const newPlaying = mapped.find((s: Song) => s.isPlaying);
      setSongs((prev) => {
        const curPlaying = prev.find((s) => s.isPlaying);
        if (!newPlaying && curPlaying) {
          return prev.map((s) => ({ ...s, isPlaying: false }));
        }
        if (newPlaying && curPlaying?.id !== newPlaying.id) {
          const hasNewSong = prev.some((s) => s.id === newPlaying.id);
          let updated = prev
            .filter((s) => s.id !== curPlaying?.id)
            .map((s) => ({ ...s, isPlaying: s.id === newPlaying.id }));
          if (!hasNewSong) updated = [newPlaying, ...updated];
          return updated;
        }
        return prev;
      });
      if (isUserBusy()) {
        pendingSongs.current = mapped;
      } else {
        applySongs(mapped);
        pendingSongs.current = null;
      }
    };

    const handleRoomUpdate = (data: any) => {
      if (data && !data.isActive) {
        // Graceful close: show overlay first, then transition to closed screen
        setRoomClosing(true);
        try { localStorage.removeItem("crowddj_last_room"); } catch {}
        setTimeout(() => setError("This room has been closed"), 3000);
        return;
      }
      setRoom(data);
    };

    const handleServerTime = (serverTime: number) => {
      serverTimeOffset.current = serverTime - Date.now();
    };

    const handleRoomClosed = () => {
      setRoomClosing(true);
      try { localStorage.removeItem("crowddj_last_room"); } catch {}
      setTimeout(() => setError("This room has been closed by the host"), 3000);
    };

    socket.on("songs-update", handleSongsUpdate);
    socket.on("room-update", handleRoomUpdate);
    socket.on("room-closed", handleRoomClosed);
    socket.on("server-time", handleServerTime);

    // Polling — always fetch songs to supplement socket updates
    let pollCount = 0;
    const interval = setInterval(() => {
      fetch(`/api/rooms/${code}/sync`, { method: "POST" }).then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          if (data.spotifyTrack) setSpotifyTrack(data.spotifyTrack);
        }
      }).catch(() => {});
      fetchSongs(); // Always fetch songs for freshness
      pollCount++;
      if (pollCount % 4 === 0) {
        fetch(`/api/rooms/${code}`).then(async (res) => {
          if (res.ok) setRoom(await res.json());
        }).catch(() => {});
        if (fingerprint) {
          const storedGid = getSavedGuestId(code);
          fetch(`/api/rooms/${code}/guest`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fingerprint, ...(storedGid && { guestId: storedGid }) }),
          }).then(async (res) => {
            if (res.ok) {
              const data = await res.json();
              if (typeof data.votesUsed === "number") {
                votesUsedRef.current = data.votesUsed;
                setVotesUsed(data.votesUsed);
              }
              if (data.lastVoteReset) {
                setLastVoteReset(new Date(data.lastVoteReset).getTime());
              }
            }
          }).catch(() => {});
        }
      }
    }, 5000);

    const flushInterval = setInterval(() => {
      if (pendingSongs.current && !isUserBusy()) {
        applySongs(pendingSongs.current);
        pendingSongs.current = null;
      }
    }, 1000);

    return () => {
      socket.emit("leave-room", code);
      socket.off("songs-update", handleSongsUpdate);
      socket.off("room-update", handleRoomUpdate);
      socket.off("room-closed", handleRoomClosed);
      socket.off("server-time", handleServerTime);
      clearInterval(interval);
      clearInterval(flushInterval);
    };
  }, [code, fetchSongs, applySongs]);

  // Pull-to-refresh: non-passive touch listeners to prevent native overscroll
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      if (el.scrollTop <= 0) {
        pullStartY.current = e.touches[0].clientY;
      } else {
        pullStartY.current = 0;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!pullStartY.current || pullRefreshRef.current) return;
      const delta = e.touches[0].clientY - pullStartY.current;
      if (delta > 0 && el.scrollTop <= 0) {
        e.preventDefault();
        const dist = Math.min(delta * 0.5, 80);
        pullDistRef.current = dist;
        setPullDistance(dist);
      } else {
        pullDistRef.current = 0;
        setPullDistance(0);
      }
    };

    const onTouchEnd = () => {
      if (pullDistRef.current >= PULL_THRESHOLD && !pullRefreshRef.current) {
        pullRefreshRef.current = true;
        setPullRefreshing(true);
        setPullDistance(PULL_THRESHOLD);
        fetchSongs().finally(() => {
          pullRefreshRef.current = false;
          setPullRefreshing(false);
          setPullDistance(0);
        });
      } else {
        setPullDistance(0);
      }
      pullDistRef.current = 0;
      pullStartY.current = 0;
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, [fetchSongs]);

  // Poll for request approvals to send in-app notifications
  const notifSeeded = useRef(false);
  useEffect(() => {
    if (!notificationsEnabled || !fingerprint) return;
    notifSeeded.current = false;
    knownApproved.current = new Set();
    const checkRequests = async () => {
      const res = await fetch(`/api/rooms/${code}/my-requests?fingerprint=${encodeURIComponent(fingerprint)}`);
      if (!res.ok) return;
      const reqs = await res.json();
      if (!notifSeeded.current) {
        for (const r of reqs) {
          if (r.status === "approved") knownApproved.current.add(r.id);
        }
        notifSeeded.current = true;
        return;
      }
      for (const r of reqs) {
        if (r.status === "approved" && !knownApproved.current.has(r.id)) {
          knownApproved.current.add(r.id);
          setInAppNotif({
            title: "Song Approved!",
            body: `"${r.trackName}" by ${r.artistName} was added to the queue`,
            art: r.albumArt || undefined,
          });
          setTimeout(() => setInAppNotif(null), 4000);
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
        votesUsedRef.current = 0;
        setVotesUsed(0);
        setLastVoteReset(Date.now());
        // Clear vote indicators locally
        setSongs((prev) =>
          prev.map((s) => ({
            ...s,
            votes: s.votes.filter((v) => v.guestId !== guestId),
          }))
        );
        // Trigger server-side vote cleanup, then refresh songs so poll doesn't restore old badges
        if (fingerprint) {
          fetch(`/api/rooms/${code}/guest`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fingerprint }),
          }).then(async () => {
            const res = await fetch(`/api/rooms/${code}/songs`);
            if (res.ok) applySongs(await res.json());
          });
        }
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

  // Re-sort songs by netScore locally (keeps playing + locked songs in place)
  const optimisticReorder = (songs: Song[]): Song[] => {
    const playing = songs.filter((s) => s.isPlaying);
    const locked = songs.filter((s) => !s.isPlaying && s.isLocked);
    const rest = songs.filter((s) => !s.isPlaying && !s.isLocked);
    rest.sort((a, b) => b.netScore - a.netScore || 0);
    // Rebuild: playing first, then merge locked (keep relative position) and sorted rest
    const queue: Song[] = [];
    let restIdx = 0;
    const nonPlaying = songs.filter((s) => !s.isPlaying);
    for (let i = 0; i < nonPlaying.length; i++) {
      const original = nonPlaying[i];
      if (original.isLocked) {
        queue.push(original);
      } else if (restIdx < rest.length) {
        queue.push(rest[restIdx++]);
      }
    }
    return [...playing, ...queue];
  };

  const vote = async (songId: string, value: 1 | -1) => {
    if (!fingerprint) return;
    if (room?.votingPaused) {
      setRequestStatus("Voting is paused by the DJ");
      setTimeout(() => setRequestStatus(""), 3000);
      return;
    }

    lastInteraction.current = Date.now();
    // Cancel any pending post-vote sync since we're voting again
    if (postVoteSyncTimer.current) {
      clearTimeout(postVoteSyncTimer.current);
      postVoteSyncTimer.current = null;
    }

    const limit = room?.votesPerUser ?? 5;

    // Check if there's an opposite vote to reclaim
    // e.g. downvoting when you have upvotes removes one upvote (refunds the vote)
    const song = songs.find((s) => s.id === songId);
    const myVotes = song?.votes?.filter((v) => v.guestId === guestId) || [];
    const oppositeVote = myVotes.find((v) => v.value !== value);
    const isReclaim = !!oppositeVote;

    if (isReclaim) {
      // RECLAIM: remove one opposite vote, refund it
      votesUsedRef.current = Math.max(0, votesUsedRef.current - 1);
      setVotesUsed(votesUsedRef.current);
      // Update score immediately, defer reorder
      let removed = false;
      setSongs((prev) =>
        prev.map((s) => {
          if (s.id !== songId) return s;
          const filtered = s.votes.filter((v) => {
            if (!removed && v.guestId === guestId && v.value !== value) {
              removed = true;
              return false;
            }
            return true;
          });
          const oppositeWasUp = oppositeVote!.value === 1;
          const newUp = s.upvotes - (oppositeWasUp ? 1 : 0);
          const newDown = s.downvotes - (oppositeWasUp ? 0 : 1);
          return { ...s, votes: filtered, upvotes: newUp, downvotes: newDown, netScore: newUp - newDown };
        })
      );
    } else {
      // NEW VOTE: check limit
      if (votesUsedRef.current >= limit) {
        setRequestStatus("Out of votes! They'll reset soon.");
        setTimeout(() => setRequestStatus(""), 3000);
        return;
      }
      votesUsedRef.current = Math.min(votesUsedRef.current + 1, limit);
      setVotesUsed(votesUsedRef.current);
      // Update score immediately, defer reorder
      setSongs((prev) =>
        prev.map((s) => {
          if (s.id !== songId) return s;
          const newUp = s.upvotes + (value === 1 ? 1 : 0);
          const newDown = s.downvotes + (value === -1 ? 1 : 0);
          return {
            ...s,
            votes: [...(s.votes || []), { guestId, value }],
            upvotes: newUp,
            downvotes: newDown,
            netScore: newUp - newDown,
          };
        })
      );
    }

    // Defer reorder — waits 1s after last vote so songs don't jump on every tap
    if (reorderTimer.current) clearTimeout(reorderTimer.current);
    reorderTimer.current = setTimeout(() => {
      setSongs((prev) => optimisticReorder(prev));
      reorderTimer.current = null;
    }, 1000);

    // Schedule server sync 800ms from THIS click (resets on each click)
    if (postVoteSyncTimer.current) clearTimeout(postVoteSyncTimer.current);
    postVoteSyncTimer.current = setTimeout(async () => {
      // Wait for all vote API calls to finish on server
      while (inFlightVotes.current > 0) {
        await new Promise((r) => setTimeout(r, 100));
      }
      // Notify other clients via socket
      getSocket().emit("vote-update", code);
      // Fetch authoritative data and apply BEFORE clearing busy state
      // so stale socket broadcasts can't overwrite in the gap
      const res = await fetch(`/api/rooms/${code}/songs`);
      if (res.ok) {
        const data = (await res.json()).map((s: any) => ({
          ...s, netScore: s.upvotes - s.downvotes, votes: s.votes || [],
        }));
        applySongs(data);
      }
      pendingSongs.current = null;
    }, 800);

    inFlightVotes.current++;
    try {
      const res = await fetch(`/api/rooms/${code}/vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ songId, value, fingerprint, guestId }),
      });

      if (!res.ok) {
        // Revert the optimistic ref update
        if (isReclaim) {
          votesUsedRef.current = Math.min(votesUsedRef.current + 1, limit);
        } else {
          votesUsedRef.current = Math.max(0, votesUsedRef.current - 1);
        }
        setVotesUsed(votesUsedRef.current);
        if (res.status === 429) {
          setRequestStatus("Out of votes! They'll reset soon.");
          setTimeout(() => setRequestStatus(""), 3000);
        }
      }
    } finally {
      inFlightVotes.current--;
      lastInteraction.current = Date.now();
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
      const status = data.status === "pending" ? "pending" as const : "added" as const;
      setRecentlyRequested((prev) => new Map(prev).set(track.spotifyUri, status));
      setRequestStatus(
        status === "pending" ? "Request sent! Waiting for host approval." : "Song added to queue!"
      );
      if (status !== "pending") {
        // Refresh songs list and close search so they can see/vote on it
        getSocket().emit("song-requested", code);
        const songsRes = await fetch(`/api/rooms/${code}/songs`);
        if (songsRes.ok) applySongs(await songsRes.json());
        setSearchQuery("");
        setSearchResults([]);
        setShowSearch(false);
      }
    } else {
      setRequestStatus(data.error || "Failed to request song");
    }
    setTimeout(() => setRequestStatus(""), 3000);
  };

  if (error) {
    const isClosed = error.includes("closed") || error.includes("expired");
    return (
      <div className="min-h-dvh flex items-center justify-center px-4 select-none" style={{ animation: 'fadeIn 0.4s ease-out' }}>
        <div className="text-center space-y-4">
          <div className="text-5xl mb-2">{isClosed ? "\u{1F3B5}" : "\u{1F50D}"}</div>
          <p className="text-2xl font-bold">{isClosed ? "Party's Over!" : error}</p>
          {isClosed && (
            <>
              <p className="text-text-secondary">The host has closed this room.</p>
              <p className="text-text-secondary text-sm">Thanks for vibing!</p>
            </>
          )}
          <a href="/" className="inline-block mt-4 px-6 py-2.5 bg-accent hover:bg-accent-hover text-black font-semibold rounded-xl transition-colors">
            Join Another Room
          </a>
        </div>
      </div>
    );
  }

  if (!room || pageStatus === "loading") {
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
    setPageStatus("welcome");
    saveGuestName(code, trimmed);
    if (room) saveLastRoom(code, room.name);
    setTimeout(() => setPageStatus("ready"), 2000);
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
        saveGuestId(code, data.guestId);
      }
    }
  };

  if (pageStatus === "need_name") {
    return (
      <div className="min-h-dvh flex items-center justify-center px-4 name-form-enter select-none">
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

  if (pageStatus === "welcome") {
    const firstName = guestName.split(" ")[0];
    return (
      <div className="min-h-dvh flex items-center justify-center px-4 select-none">
        <div className="text-center space-y-3 animate-[fadeIn_0.4s_ease-out]">
          <p className="text-4xl">🎵</p>
          <h1 className="text-2xl font-bold">Welcome, {firstName}!</h1>
          <p className="text-text-secondary text-sm">
            You&apos;re in <span className="text-white font-medium">{room.name}</span>
          </p>
          <div className="pt-2">
            <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto" />
          </div>
        </div>
      </div>
    );
  }

  const votesRemaining = Math.max(0, room.votesPerUser - votesUsed);
  const outOfVotes = votesRemaining === 0;
  const queuePlaying = songs.find((s) => s.isPlaying);
  const nowPlaying = spotifyTrack
    ? (queuePlaying && queuePlaying.spotifyUri === spotifyTrack.uri
      ? queuePlaying
      : { trackName: spotifyTrack.name, artistName: spotifyTrack.artist, albumArt: spotifyTrack.albumArt, spotifyUri: spotifyTrack.uri, id: '__spotify__', isPlaying: true } as any)
    : queuePlaying;
  return (
    <div className="flex flex-col max-w-lg lg:max-w-3xl mx-auto overflow-hidden select-none safe-top" style={{ height: 'var(--app-height, 100dvh)' }}>
      {/* Room closing overlay */}
      {roomClosing && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center bg-bg-primary/80 backdrop-blur-sm" style={{ animation: 'fadeIn 0.5s ease-out' }}>
          <div className="text-center space-y-3 px-8">
            <div className="text-5xl">🎵</div>
            <p className="text-2xl font-bold">Party's Over!</p>
            <p className="text-text-secondary">The host has closed this room.</p>
            <p className="text-text-secondary text-sm">Thanks for vibing!</p>
          </div>
        </div>
      )}
      {!isOnline && (
        <div className="flex-shrink-0 bg-red-600 text-white text-center text-xs py-1 font-medium z-[70]">
          No internet connection
        </div>
      )}
      {/* In-app notification toast */}
      {inAppNotif && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-[90%] max-w-sm animate-[slideDown_0.3s_ease-out]">
          <div className="flex items-center gap-3 p-3 bg-bg-card border border-accent/30 rounded-xl shadow-xl">
            {inAppNotif.art && (
              <img src={inAppNotif.art} alt="" className="w-10 h-10 rounded-lg" />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-accent">{inAppNotif.title}</p>
              <p className="text-xs text-text-secondary truncate">{inAppNotif.body}</p>
            </div>
            <button onClick={() => setInAppNotif(null)} className="text-text-secondary hover:text-white p-1">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex-shrink-0 relative z-[60]">
      <div className="backdrop-blur-xl px-4 pt-3 pb-3">
        {/* Greeting */}
        <p className="text-accent text-xs font-medium mb-1">
          {(() => {
            const h = new Date().getHours();
            const greeting = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
            return `${greeting}, ${guestName.split(" ")[0]}`;
          })()}
        </p>
        {/* Room name + vote badge row */}
        <div className="flex items-end justify-between mb-3">
          <div className="min-w-0 flex-1 mr-3">
            <h1 className="font-bold text-lg tracking-tight truncate leading-tight">{room.name}</h1>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-text-secondary text-xs">{room.host.name}</span>
              <span className="inline-block w-[3px] h-[3px] rounded-full bg-white/25" />
              <span className="font-mono text-text-secondary text-xs select-text">{room.code}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => {
                if (notificationsEnabled) {
                  setNotificationsEnabled(false);
                  setShowNotifGuide(false);
                } else {
                  setNotificationsEnabled(true);
                  setShowNotifGuide(true);
                }
              }}
              className={`p-1.5 rounded-lg transition-colors ${
                notificationsEnabled
                  ? "text-accent bg-accent/15"
                  : "text-text-secondary hover:text-white"
              }`}
              title={notificationsEnabled ? "Notifications on" : "Enable notifications"}
            >
              <div className="relative">
                <svg className="w-4 h-4" fill={notificationsEnabled ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
                {notificationsEnabled && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-accent rounded-full" />
                )}
              </div>
            </button>
            {room.votingPaused ? (
              <span className="px-2.5 py-0.5 bg-yellow-500/15 text-yellow-500 text-xs font-semibold rounded-full">Paused</span>
            ) : outOfVotes ? (
              <div className="text-right">
                <span className="px-2.5 py-0.5 bg-downvote/15 text-downvote text-xs font-semibold rounded-full tabular-nums">0 / {room.votesPerUser}</span>
                {resetCountdown && (
                  <p className="text-text-secondary text-[10px] mt-0.5 tabular-nums">{resetCountdown}</p>
                )}
              </div>
            ) : (
              <div className="text-right">
                <span className="px-2.5 py-0.5 bg-accent/15 text-accent text-xs font-semibold rounded-full tabular-nums">{votesRemaining} / {room.votesPerUser}</span>
                {resetCountdown && (
                  <p className="text-text-secondary text-[10px] mt-0.5 tabular-nums">{resetCountdown}</p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Notification / Add to Home Screen guide */}
        {showNotifGuide && (
          <div className="mb-3 p-3 bg-accent/5 border border-accent/20 rounded-xl">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                <p className="text-sm font-semibold text-accent mb-1">Get Notifications</p>
                <p className="text-xs text-text-secondary mb-2">
                  Add this page to your home screen for real-time notifications.
                </p>
                <div className="space-y-1.5 text-xs text-text-secondary">
                  <p><span className="text-accent font-bold">1.</span> Tap Share <svg className="w-3.5 h-3.5 inline mx-0.5 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg> in your browser</p>
                  <p><span className="text-accent font-bold">2.</span> Select &quot;Add to Home Screen&quot;</p>
                  <p><span className="text-accent font-bold">3.</span> Open from home screen</p>
                </div>
              </div>
              <button onClick={() => setShowNotifGuide(false)} className="text-text-secondary hover:text-white p-0.5 flex-shrink-0">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        )}

        {/* Search bar */}
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
            className="w-full pl-9 pr-9 py-2.5 bg-bg-card border border-border rounded-xl text-sm focus:outline-none focus:border-accent transition-colors"
          />
          {(searchQuery || showSearch) && (
            <button
              onClick={() => {
                setSearchQuery("");
                setSearchResults([]);
                setShowSearch(false);
                setRecentlyRequested(new Map());
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

      {/* Search results dropdown — overlays content from below header */}
      {showSearch && searchQuery.trim() && (() => {
        const q = searchQuery.trim().toLowerCase();
        const queueMatches = songs.filter(
          (s) =>
            !s.isPlaying &&
            (s.trackName.toLowerCase().includes(q) ||
              s.artistName.toLowerCase().includes(q))
        ).sort((a, b) => {
          // Locked songs stay at their original position (top), then sort by netScore
          if (a.isLocked && !b.isLocked) return -1;
          if (!a.isLocked && b.isLocked) return 1;
          return b.netScore - a.netScore;
        });
        if (queueMatches.length === 0 && searchResults.length === 0 && !searching) return null;

        return (
          <>
          <div className="fixed inset-0 z-40" onClick={() => { setShowSearch(false); setSearchQuery(""); setSearchResults([]); setRecentlyRequested(new Map()); }} />
          <div className="absolute left-0 right-0 mx-4 mt-1 z-50 bg-bg-card border border-white/[0.08] rounded-xl overflow-hidden shadow-2xl">
            <div className="max-h-72 overflow-y-auto divide-y divide-border/50">
              {queueMatches.length > 0 && (
                <div className="p-2 space-y-1">
                  <p className="text-text-secondary text-[10px] font-semibold uppercase tracking-wider px-1">In Queue</p>
                  {queueMatches.map((song) => {
                    const myVotes = song.votes?.filter((v) => v.guestId === guestId) || [];
                    const myUp = myVotes.filter((v) => v.value === 1).length;
                    const myDown = myVotes.filter((v) => v.value === -1).length;

                    return (
                      <div key={song.id} className={`flex items-center gap-3 p-2 rounded-lg ${song.isLocked ? "bg-yellow-500/5" : ""}`}>
                        {song.albumArt && (
                          <img src={song.albumArt} alt="" className="w-9 h-9 rounded-md" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{song.trackName}</p>
                          <p className="text-text-secondary text-xs truncate">{song.artistName}</p>
                        </div>
                        {song.isLocked ? (
                          <span className="text-[10px] text-yellow-500/50 flex-shrink-0">Locked</span>
                        ) : (
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              onClick={() => vote(song.id, 1)}
                              className={`relative p-1.5 rounded-lg hover:bg-upvote/10 ${myUp > 0 ? "bg-upvote/10" : ""}`}
                            >
                              <svg className={`w-4 h-4 ${myUp > 0 ? "text-upvote" : "text-text-secondary"}`} fill={myUp > 0 ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                              </svg>
                              {myUp > 0 && (
                                <span className="absolute -top-1 -right-1 w-4 h-4 bg-upvote text-black text-[10px] font-bold rounded-full flex items-center justify-center">{myUp}</span>
                              )}
                            </button>
                            <span className={`text-xs font-medium min-w-[1.2rem] text-center ${song.netScore > 0 ? "text-upvote" : song.netScore < 0 ? "text-downvote" : "text-white/20"}`}>
                              {song.netScore === 0 ? "\u00B7" : song.netScore}
                            </span>
                            <button
                              onClick={() => vote(song.id, -1)}
                              className={`relative p-1.5 rounded-lg hover:bg-downvote/10 ${myDown > 0 ? "bg-downvote/10" : ""}`}
                            >
                              <svg className={`w-4 h-4 ${myDown > 0 ? "text-downvote" : "text-text-secondary"}`} fill={myDown > 0 ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                              {myDown > 0 && (
                                <span className="absolute -top-1 -right-1 w-4 h-4 bg-downvote text-white text-[10px] font-bold rounded-full flex items-center justify-center">{myDown}</span>
                              )}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {searchResults.length > 0 && (
                <div className="p-2 space-y-1">
                  <p className="text-text-secondary text-[10px] font-semibold uppercase tracking-wider px-1">From Spotify</p>
                  {searchResults.map((track: any) => {
                    const recentStatus = recentlyRequested.get(track.spotifyUri);
                    const unavailable = track.inQueue || track.alreadyPlayed || !!recentStatus;
                    return (
                    <button
                      key={track.spotifyUri}
                      onClick={() => !unavailable && requestSong(track)}
                      disabled={unavailable}
                      className={`w-full flex items-center gap-3 p-2 rounded-lg text-left transition-colors ${
                        unavailable ? "opacity-50 cursor-default" : "hover:bg-bg-card-hover"
                      }`}
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
                      <span className={`text-xs font-medium ${
                        recentStatus === "pending" ? "text-yellow-500" : recentStatus === "added" ? "text-upvote" : track.alreadyPlayed ? "text-text-secondary" : track.inQueue ? "text-text-secondary" : "text-accent"
                      }`}>
                        {recentStatus === "pending" ? "Pending" : recentStatus === "added" ? "Added!" : track.alreadyPlayed ? "Played" : track.inQueue ? "In queue" : "+ Add"}
                      </span>
                    </button>
                    );
                  })}
                </div>
              )}

              {searching && (
                <div className="p-3 text-center text-text-secondary text-xs">Searching...</div>
              )}

              {searchResults.length > 0 && (room.requireApproval || room.maxSongsPerGuest > 0) && (
                <div className="px-3 py-2 border-t border-border/50 flex flex-wrap gap-x-3 gap-y-0.5">
                  {room.requireApproval && (
                    <span className="text-[10px] text-yellow-500/80">Requests need host approval</span>
                  )}
                  {room.maxSongsPerGuest > 0 && (
                    <span className="text-[10px] text-text-secondary">Limit: {room.maxSongsPerGuest} song{room.maxSongsPerGuest === 1 ? "" : "s"} per person</span>
                  )}
                </div>
              )}
            </div>
          </div>
          </>
        );
      })()}
      </div>

      {/* Status toast — above search dropdown (z-50) */}
      {requestStatus && (
        <div className="fixed inset-0 flex items-center justify-center pointer-events-none px-8" style={{ zIndex: 10000 }}>
          <div className="px-6 py-4 bg-bg-card border border-accent/30 rounded-2xl text-sm text-center shadow-lg backdrop-blur-sm pointer-events-auto">
            {requestStatus}
          </div>
        </div>
      )}

      {/* Scrollable content area */}
      <div
        ref={scrollRef}
        className={`flex-1 overflow-y-auto overscroll-none transition-opacity duration-200 ${showSearch ? "opacity-30 pointer-events-none" : ""}`}
        onScroll={() => { lastScrollTime.current = Date.now(); }}
      >
      {/* Pull-to-refresh indicator */}
      {pullDistance > 0 && (
        <div className="flex justify-center py-2" style={{ height: pullDistance }}>
          <div className={`text-accent text-xs font-medium flex items-center gap-2 ${pullRefreshing ? "animate-pulse" : ""}`}>
            {pullRefreshing ? (
              <><div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" /> Refreshing...</>
            ) : pullDistance >= PULL_THRESHOLD ? (
              "Release to refresh"
            ) : (
              "Pull to refresh"
            )}
          </div>
        </div>
      )}

      {/* Now Playing */}
      {nowPlaying && (
        <div className="mx-4 mt-3 relative rounded-2xl border border-accent/30">
          {/* Blurred album art background */}
          {nowPlaying.albumArt && (
            <div className="absolute inset-0 rounded-2xl overflow-hidden">
              <img src={nowPlaying.albumArt} alt="" className="w-full h-full object-cover scale-[2] blur-3xl opacity-40" />
              <div className="absolute inset-0 bg-black/50" />
            </div>
          )}
          <div className="relative flex items-center gap-4 p-4">
            {nowPlaying.albumArt && (
              <img src={nowPlaying.albumArt} alt="" className="w-16 h-16 rounded-xl shadow-lg flex-shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-[10px] text-accent font-semibold uppercase tracking-wider mb-0.5">Now Playing</p>
              <p className="font-semibold truncate text-[15px]">{nowPlaying.trackName}</p>
              <p className="text-white/70 text-sm truncate">{nowPlaying.artistName}</p>
            </div>
            <div className="flex items-center gap-[3px] flex-shrink-0">
              <span className="w-[3px] h-3 bg-accent rounded-full animate-pulse" />
              <span className="w-[3px] h-5 bg-accent rounded-full animate-pulse [animation-delay:0.2s]" />
              <span className="w-[3px] h-2.5 bg-accent rounded-full animate-pulse [animation-delay:0.4s]" />
            </div>
          </div>
        </div>
      )}

      {/* Song List */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <p className="text-white/50 text-xs font-semibold tracking-wide">Up Next</p>
        <p className="text-white/25 text-[10px]">
          {room.autoShuffle ? "Sorted by votes" : "DJ-ordered"}
        </p>
      </div>
      <div className="flex-1 relative overflow-hidden">
      <div ref={songListRef} className="h-full overflow-y-auto px-4 py-1 space-y-1.5 lg:grid lg:grid-cols-2 lg:gap-3 lg:space-y-0 pb-6" style={{ maskImage: 'linear-gradient(to bottom, black 0%, black 85%, transparent 100%)', WebkitMaskImage: 'linear-gradient(to bottom, black 0%, black 85%, transparent 100%)' }}>
        {songs.filter(s => !s.isPlaying).map((song, i) => {
          const myVotes = song.votes?.filter((v) => v.guestId === guestId) || [];
          const myUpvotes = myVotes.filter((v) => v.value === 1).length;
          const myDownvotes = myVotes.filter((v) => v.value === -1).length;
          const isQueuedNext = song.isLocked && room.lastPreQueuedId === song.id;
          const isManualLocked = song.isLocked && !isQueuedNext;

          return (
            <div
              key={song.id}
              className={`song-card flex items-center gap-3 p-3 rounded-xl border transition-colors ${
                isQueuedNext
                  ? "bg-accent/8 border-accent/30"
                  : isManualLocked
                  ? "bg-yellow-500/5 border-yellow-500/20"
                  : "bg-white/[0.03] border-white/[0.06]"
              }`}
            >
              <div className="w-5 text-center flex-shrink-0">
                {isManualLocked ? (
                  <svg className="w-3.5 h-3.5 text-yellow-500 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                ) : (
                  <span className={`text-xs font-medium ${isQueuedNext ? "text-accent font-bold" : "text-white/30"}`}>{i + 1}</span>
                )}
              </div>

              {song.albumArt && (
                <img src={song.albumArt} alt="" className={`w-12 h-12 rounded-lg flex-shrink-0 ${isQueuedNext ? "ring-2 ring-accent/40" : ""}`} />
              )}

              <div className="flex-1 min-w-0">
                {isQueuedNext && (
                  <p className="text-[10px] font-semibold text-accent uppercase tracking-wider">Up Next</p>
                )}
                <p className="font-medium text-sm truncate">{song.trackName}</p>
                <p className="text-white/40 text-xs truncate">{song.artistName}</p>
              </div>

              {isManualLocked ? (
                <div className="flex-shrink-0 text-right pr-1">
                  <p className="text-[10px] text-yellow-500/50">Locked</p>
                </div>
              ) : (
                <div className={`flex items-center gap-0.5 flex-shrink-0 ${isQueuedNext ? "opacity-50" : ""}`}>
                  <button
                    onClick={() => !isQueuedNext && vote(song.id, 1)}
                    disabled={isQueuedNext}
                    className={`vote-btn p-2.5 rounded-xl relative ${
                      isQueuedNext
                        ? "cursor-default"
                        : myUpvotes > 0
                        ? "bg-upvote/15"
                        : "hover:bg-white/[0.06] active:bg-upvote/10"
                    }`}
                  >
                    <svg className={`w-5 h-5 ${myUpvotes > 0 ? "text-upvote" : "text-white/40"}`} fill={myUpvotes > 0 ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                    </svg>
                    {myUpvotes > 0 && (
                      <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-upvote text-black text-[10px] font-bold rounded-full flex items-center justify-center">
                        {myUpvotes}
                      </span>
                    )}
                  </button>

                  <span
                    className={`text-sm font-semibold min-w-[1.5rem] text-center tabular-nums ${
                      song.netScore > 0
                        ? "text-upvote"
                        : song.netScore < 0
                        ? "text-downvote"
                        : "text-white/20"
                    }`}
                  >
                    {song.netScore === 0 ? "\u00B7" : song.netScore}
                  </span>

                  <button
                    onClick={() => !isQueuedNext && vote(song.id, -1)}
                    disabled={isQueuedNext}
                    className={`vote-btn p-2.5 rounded-xl relative ${
                      isQueuedNext
                        ? "cursor-default"
                        : myDownvotes > 0
                        ? "bg-downvote/15"
                        : "hover:bg-white/[0.06] active:bg-downvote/10"
                    }`}
                  >
                    <svg className={`w-5 h-5 ${myDownvotes > 0 ? "text-downvote" : "text-white/40"}`} fill={myDownvotes > 0 ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                    {myDownvotes > 0 && (
                      <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-downvote text-white text-[10px] font-bold rounded-full flex items-center justify-center">
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

    </div>
    </div>
  );
}
