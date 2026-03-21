"use client";

import { useState, useEffect, useCallback, useRef, use } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { getFingerprint } from "@/lib/fingerprint";
import { getSocket } from "@/lib/socket";
import { useAppHeight, useNetworkStatus } from "@/lib/pwa";
import HelpGuide from "@/components/HelpGuide";

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
  isPinned: boolean;
  pinnedPosition: number | null;
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
  sortMode: string;
  explicitFilter: boolean;
  requireApproval: boolean;
  maxSongsPerGuest: number;
  lastPreQueuedId: string | null;
  scheduledStart: string | null;
  brandColor: string;
  brandName: string;
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
  const [spotifyPlaying, setSpotifyPlaying] = useState(true);
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
  const [showHelp, setShowHelp] = useState(false);
  const [inAppNotif, setInAppNotif] = useState<{ title: string; body: string; art?: string } | null>(null);
  const lastInteraction = useRef(0); // last vote or scroll activity
  const pendingSongs = useRef<Song[] | null>(null);
  const inFlightVotes = useRef(0);
  const votesUsedRef = useRef(0);
  const serverTimeOffset = useRef(0); // serverTime - localTime, for timer sync
  const postVoteSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reorderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrollTime = useRef(0);
  const lastPreQueuedRef = useRef<string | null>(null); // track pre-queue changes from sync poll
  const [songListRef] = useAutoAnimate({ duration: 300 });
  const knownApproved = useRef<Set<string>>(new Set());
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [scheduledCountdown, setScheduledCountdown] = useState("");
  const [previewTrackId, setPreviewTrackId] = useState<string | null>(null);
  const [previewTrackInfo, setPreviewTrackInfo] = useState<{ name: string; artist: string; albumArt?: string } | null>(null);
  const [previewTrackData, setPreviewTrackData] = useState<any>(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const pullStartY = useRef(0);
  const pullDistRef = useRef(0);
  const pullRefreshRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const PULL_THRESHOLD = 60;

  const applySongs = useCallback((data: Song[]) => {
    setSongs(data);
    // Note: votesUsed is NOT derived from visible songs here — the songs API
    // excludes played songs and has a display limit, so counting votes from
    // visible songs under-counts and causes "out of votes" bugs.
    // Instead, votesUsed is synced from: (1) initial guest endpoint,
    // (2) vote API responses, (3) periodic guest endpoint poll.
  }, []);

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
      lastPreQueuedRef.current = roomData.lastPreQueuedId ?? null;
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

    // Polling — fetch songs only when socket is disconnected, sync always runs
    let pollCount = 0;
    let tabHidden = false;
    const onVisChange = () => { tabHidden = document.hidden; };
    document.addEventListener("visibilitychange", onVisChange);
    const interval = setInterval(() => {
      if (tabHidden) return; // Skip polling when tab is backgrounded
      fetch(`/api/rooms/${code}/sync`, { method: "POST" }).then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          if (data.playing === false) {
            setSpotifyPlaying(false);
          } else if (data.spotifyTrack) {
            setSpotifyPlaying(data.spotifyPlaying !== false);
            // If the track changed from what we know, refresh songs immediately
            setSpotifyTrack((prev) => {
              if (prev?.uri !== data.spotifyTrack.uri) fetchSongs();
              return data.spotifyTrack;
            });
          }
          // Detect pre-queue changes — fetch fresh songs so isLocked updates
          // (the one-shot socket broadcast can be missed on mobile)
          const newPreQueued = data.lastPreQueuedId ?? null;
          if (newPreQueued !== lastPreQueuedRef.current) {
            lastPreQueuedRef.current = newPreQueued;
            setRoom((prev) => prev ? { ...prev, lastPreQueuedId: newPreQueued } : prev);
            if (newPreQueued) fetchSongs();
          }
        }
      }).catch(() => {});
      if (!socket.connected) fetchSongs(); // Only fetch songs when socket is down
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
      document.removeEventListener("visibilitychange", onVisChange);
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


  // Scheduled room countdown timer
  useEffect(() => {
    if (!room?.scheduledStart) { setScheduledCountdown(""); return; }
    const target = new Date(room.scheduledStart).getTime();
    const tick = () => {
      const remaining = target - Date.now();
      if (remaining <= 0) { setScheduledCountdown(""); return; }
      const hours = Math.floor(remaining / 3600000);
      const mins = Math.floor((remaining % 3600000) / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      if (hours > 0) setScheduledCountdown(`${hours}h ${mins}m ${secs}s`);
      else if (mins > 0) setScheduledCountdown(`${mins}m ${secs}s`);
      else setScheduledCountdown(`${secs}s`);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [room?.scheduledStart]);

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
    if ((room?.sortMode || (room?.autoShuffle ? "votes" : "manual")) !== "votes") {
      setRequestStatus("Voting is off while the DJ controls the queue");
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

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // Sync authoritative vote count from server if provided
        if (data?.votesUsed !== undefined) {
          votesUsedRef.current = data.votesUsed;
          setVotesUsed(data.votesUsed);
        } else {
          // Fallback: revert the optimistic ref update
          if (isReclaim) {
            votesUsedRef.current = Math.min(votesUsedRef.current + 1, limit);
          } else {
            votesUsedRef.current = Math.max(0, votesUsedRef.current - 1);
          }
          setVotesUsed(votesUsedRef.current);
        }
        if (res.status === 429) {
          setRequestStatus("Out of votes! They'll reset soon.");
          setTimeout(() => setRequestStatus(""), 3000);
        }
      } else if (data?.votesUsed !== undefined) {
        // Sync authoritative vote count from server on success
        votesUsedRef.current = data.votesUsed;
        setVotesUsed(data.votesUsed);
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
      setShowSearch(false);
      return;
    }
    searchTimer.current = setTimeout(() => searchSongs(value), 300);
  };

  const openPreview = (spotifyUri: string, name: string, artist: string, albumArt?: string, trackData?: any) => {
    const id = spotifyUri.replace("spotify:track:", "");
    if (previewTrackId === id) {
      setPreviewTrackId(null);
      setPreviewTrackInfo(null);
      setPreviewTrackData(null);
      setPreviewPlaying(false);
    } else {
      setPreviewTrackId(id);
      setPreviewTrackInfo({ name, artist, albumArt });
      setPreviewTrackData(trackData || null);
      setPreviewPlaying(false);
    }
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
        <div className="text-center space-y-4 lg:bg-white/[0.04] lg:backdrop-blur-xl lg:border lg:border-white/[0.06] lg:rounded-3xl lg:p-10 lg:shadow-[0_8px_32px_rgba(0,0,0,0.3)]">
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
        // Notify socket so host sees updated guest count immediately
        getSocket().emit("guest-named", code);
      }
    }
  };

  if (pageStatus === "need_name") {
    return (
      <div className="min-h-dvh flex items-center justify-center px-4 name-form-enter select-none" style={room.brandColor ? { '--color-accent': room.brandColor, '--color-upvote': room.brandColor } as any : undefined}>
        <div className="w-full max-w-sm text-center space-y-6 lg:bg-white/[0.04] lg:backdrop-blur-xl lg:border lg:border-white/[0.06] lg:rounded-3xl lg:p-10 lg:shadow-[0_8px_32px_rgba(0,0,0,0.3)] lg:max-w-md">
          <div>
            <h1 className="text-2xl font-bold mb-1 lg:text-3xl">{room.brandName || room.name}</h1>
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
      <div className="min-h-dvh flex items-center justify-center px-4 select-none" style={room.brandColor ? { '--color-accent': room.brandColor, '--color-upvote': room.brandColor } as any : undefined}>
        <div className="text-center space-y-3 animate-[fadeIn_0.4s_ease-out] lg:bg-white/[0.04] lg:backdrop-blur-xl lg:border lg:border-white/[0.06] lg:rounded-3xl lg:p-10 lg:shadow-[0_8px_32px_rgba(0,0,0,0.3)]">
          <p className="text-4xl">🎵</p>
          <h1 className="text-2xl font-bold">Welcome, {firstName}!</h1>
          <p className="text-text-secondary text-sm">
            You&apos;re in <span className="text-white font-medium">{room.brandName || room.name}</span>
          </p>
          <div className="pt-2">
            <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto" />
          </div>
        </div>
      </div>
    );
  }


  // Show countdown for scheduled rooms
  if (scheduledCountdown) {
    return (
      <div className="min-h-dvh flex items-center justify-center px-4 select-none">
        <div className="text-center space-y-4 max-w-sm lg:bg-white/[0.04] lg:backdrop-blur-xl lg:border lg:border-white/[0.06] lg:rounded-3xl lg:p-10 lg:shadow-[0_8px_32px_rgba(0,0,0,0.3)] lg:max-w-md">
          <h1 className="text-2xl font-bold lg:text-3xl">{room.name}</h1>
          <p className="text-text-secondary text-sm">Hosted by {room.host.name}</p>
          <div className="py-6">
            <p className="text-white/40 text-xs uppercase tracking-wider mb-2">Starts in</p>
            <p className="text-4xl font-bold tabular-nums text-accent">{scheduledCountdown}</p>
          </div>
          <p className="text-text-secondary text-sm">Hang tight! The queue will appear when the event starts.</p>
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
    <div className="flex flex-col max-w-lg lg:max-w-5xl xl:max-w-6xl mx-auto overflow-hidden overscroll-none select-none safe-top lg:my-6 lg:bg-white/[0.03] lg:backdrop-blur-xl lg:border lg:border-white/[0.06] lg:rounded-3xl lg:shadow-[0_8px_32px_rgba(0,0,0,0.3)] lg:max-h-[calc(100dvh-3rem)]" style={{ height: 'var(--app-height, 100dvh)', ...(room.brandColor ? { '--color-accent': room.brandColor, '--color-upvote': room.brandColor } as any : {}) }}>
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
      {showHelp && <HelpGuide variant="guest" onClose={() => setShowHelp(false)} />}
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
      <div className="backdrop-blur-xl px-4 pt-3 pb-3 lg:px-6 lg:pt-5 lg:pb-4">
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
            <h1 className="font-bold text-lg tracking-tight truncate leading-tight lg:text-2xl">{room.brandName || room.name}</h1>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-text-secondary text-xs">{room.host.name}</span>
              <span className="inline-block w-[3px] h-[3px] rounded-full bg-white/25" />
              <span className="font-mono text-text-secondary text-xs select-text">{room.code}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => setShowHelp(true)}
              className="p-1.5 rounded-lg text-text-secondary hover:text-white transition-colors"
              title="How it works"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
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
                        ) : (room.sortMode || (room.autoShuffle ? "votes" : "manual")) !== "votes" ? (
                          <div className="flex items-center gap-1 flex-shrink-0 opacity-30 cursor-not-allowed" onClick={() => vote(song.id, 1)}>
                            <div className="p-1.5">
                              <svg className="w-4 h-4 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                              </svg>
                            </div>
                            <span className="text-xs font-medium min-w-[1.2rem] text-center text-white/20">{"\u00B7"}</span>
                            <div className="p-1.5">
                              <svg className="w-4 h-4 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </div>
                          </div>
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
                    <div
                      key={track.spotifyUri}
                      className={`w-full flex items-center gap-3 p-2 rounded-lg text-left transition-colors ${
                        unavailable ? "opacity-50" : "hover:bg-bg-card-hover"
                      }`}
                    >
                      <button
                        onClick={(e) => { e.stopPropagation(); openPreview(track.spotifyUri, track.trackName, track.artistName, track.albumArt, unavailable ? undefined : track); }}
                        className={`relative flex-shrink-0 w-9 h-9 rounded-md overflow-hidden group ${previewTrackId === track.spotifyUri.replace("spotify:track:", "") ? "ring-2 ring-accent" : ""}`}
                      >
                        {track.albumArt && <img src={track.albumArt} alt="" className="w-full h-full object-cover" />}
                        <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                          <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                        </div>
                      </button>
                      <button
                        onClick={() => openPreview(track.spotifyUri, track.trackName, track.artistName, track.albumArt, unavailable ? undefined : track)}
                        className="flex-1 min-w-0 text-left"
                      >
                        <p className="text-sm font-medium truncate">
                          {track.trackName}
                          {track.isExplicit && (
                            <span className="ml-1 text-[10px] text-text-secondary bg-text-secondary/20 px-1 rounded">E</span>
                          )}
                        </p>
                        <p className="text-text-secondary text-xs truncate">{track.artistName}</p>
                      </button>
                      <button
                        onClick={() => !unavailable && requestSong(track)}
                        disabled={unavailable}
                        className={`text-xs font-medium flex-shrink-0 px-2 py-1 rounded-lg transition-colors ${
                          unavailable ? "cursor-default" : "hover:bg-accent/10 active:bg-accent/20"
                        } ${recentStatus === "pending" ? "text-yellow-500" : recentStatus === "added" ? "text-upvote" : track.alreadyPlayed ? "text-text-secondary" : track.inQueue ? "text-text-secondary" : "text-accent"}`}
                      >
                        {recentStatus === "pending" ? "Pending" : recentStatus === "added" ? "Added!" : track.alreadyPlayed ? "Played" : track.inQueue ? "In queue" : "+ Add"}
                      </button>
                    </div>
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
        <div className="mx-4 mt-3 relative rounded-2xl border border-accent/30 lg:mx-6">
          {/* Blurred album art background */}
          {nowPlaying.albumArt && (
            <div className="absolute inset-0 rounded-2xl overflow-hidden">
              <img src={nowPlaying.albumArt} alt="" className="w-full h-full object-cover scale-[2] blur-3xl opacity-40" />
              <div className="absolute inset-0 bg-black/50" />
            </div>
          )}
          <div className="relative flex items-center gap-4 p-4">
            {nowPlaying.albumArt && (
              <img src={nowPlaying.albumArt} alt="" className="w-16 h-16 rounded-xl shadow-lg flex-shrink-0 lg:w-20 lg:h-20" />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-[10px] text-accent font-semibold uppercase tracking-wider mb-0.5">{spotifyPlaying ? "Now Playing" : "Paused"}</p>
              <p className="font-semibold truncate text-[15px]">{nowPlaying.trackName}</p>
              <p className="text-white/70 text-sm truncate">{nowPlaying.artistName}</p>
            </div>
            <div className="flex items-center gap-[3px] flex-shrink-0">
              {spotifyPlaying ? (
                <>
                  <span className="w-[3px] h-3 bg-accent rounded-full animate-pulse" />
                  <span className="w-[3px] h-5 bg-accent rounded-full animate-pulse [animation-delay:0.2s]" />
                  <span className="w-[3px] h-2.5 bg-accent rounded-full animate-pulse [animation-delay:0.4s]" />
                </>
              ) : (
                <svg className="w-5 h-5 text-white/40" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                </svg>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Song List */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2 lg:px-6 lg:pt-5 lg:pb-3">
        <p className="text-white/50 text-xs font-semibold tracking-wide">Up Next</p>
        <p className="text-white/25 text-[10px]">
          {(room.sortMode || (room.autoShuffle ? "votes" : "manual")) === "votes" ? "Sorted by votes" : (room.sortMode === "playlist" ? "Playlist order" : "DJ-ordered")}
        </p>
      </div>
      <div className="flex-1 relative overflow-hidden">
      <div ref={songListRef} className="h-full overflow-y-auto px-4 py-1 space-y-1.5 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0 lg:px-6 xl:grid-cols-3 pb-6">
        {songs.filter(s => !s.isPlaying && !(nowPlaying && s.spotifyUri === nowPlaying.spotifyUri)).map((song, i) => {
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

              <button
                onClick={() => openPreview(song.spotifyUri, song.trackName, song.artistName, song.albumArt || undefined)}
                className={`relative w-12 h-12 rounded-lg flex-shrink-0 overflow-hidden group ${isQueuedNext ? "ring-2 ring-accent/40" : ""} ${previewTrackId === song.spotifyUri.replace("spotify:track:", "") ? "ring-2 ring-accent" : ""}`}
              >
                {song.albumArt && <img src={song.albumArt} alt="" className="w-full h-full object-cover" />}
                <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                </div>
              </button>

              <button
                onClick={() => openPreview(song.spotifyUri, song.trackName, song.artistName, song.albumArt || undefined)}
                className="flex-1 min-w-0 text-left"
              >
                {isQueuedNext && (
                  <p className="text-[10px] font-semibold text-accent uppercase tracking-wider">Up Next</p>
                )}
                <p className="font-medium text-sm truncate">{song.trackName}</p>
                <p className="text-white/40 text-xs truncate">{song.artistName}</p>
              </button>

              {song.isLocked ? (
                <div className="flex-shrink-0 text-right pr-1">
                  {isQueuedNext ? (
                    <p className="text-[10px] text-accent/70 font-semibold">Up Next</p>
                  ) : (
                    <p className="text-[10px] text-yellow-500/50">Locked</p>
                  )}
                </div>
              ) : (room.sortMode || (room.autoShuffle ? "votes" : "manual")) !== "votes" ? (
                <div className="flex items-center gap-0.5 flex-shrink-0 opacity-30 cursor-not-allowed" onClick={() => vote(song.id, 1)}>
                  <div className="p-2.5">
                    <svg className="w-5 h-5 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                    </svg>
                  </div>
                  <span className="text-sm font-semibold min-w-[1.5rem] text-center tabular-nums text-white/20">{"\u00B7"}</span>
                  <div className="p-2.5">
                    <svg className="w-5 h-5 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-0.5 flex-shrink-0">
                  <button
                    onClick={() => vote(song.id, 1)}
                    className={`vote-btn p-2.5 rounded-xl relative ${
                      myUpvotes > 0
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
                    onClick={() => vote(song.id, -1)}
                    className={`vote-btn p-2.5 rounded-xl relative ${
                      myDownvotes > 0
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

      {/* Spotify Embed Preview */}
      {previewTrackId && previewTrackInfo && (
        <div className="fixed inset-0 flex items-center justify-center" style={{ zIndex: 10001 }} onClick={() => { setPreviewTrackId(null); setPreviewTrackInfo(null); setPreviewTrackData(null); setPreviewPlaying(false); }}>
          <div className="absolute inset-0 bg-black/70 backdrop-blur-md" />
          <div
            className="relative w-full max-w-[320px] mx-4 rounded-2xl overflow-hidden shadow-2xl bg-[#181818] border border-white/[0.06]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close button */}
            <button
              onClick={() => { setPreviewTrackId(null); setPreviewTrackInfo(null); setPreviewTrackData(null); setPreviewPlaying(false); }}
              className="absolute top-3 right-3 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-black/50 backdrop-blur-sm text-white/70 hover:text-white hover:bg-black/70 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            {/* Album art with play button */}
            <div className="relative aspect-square bg-black/40">
              {previewTrackInfo.albumArt ? (
                <img src={previewTrackInfo.albumArt} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <svg className="w-16 h-16 text-white/20" fill="currentColor" viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
                </div>
              )}
            </div>

            {/* Song info + play button row */}
            <div className="flex items-center gap-3 px-4 pt-3 pb-2">
              <div className="flex-1 min-w-0">
                <p className="text-base font-semibold text-white truncate">{previewTrackInfo.name}</p>
                <p className="text-sm text-white/50 truncate">{previewTrackInfo.artist}</p>
              </div>
              {/* Play button / playing indicator */}
              {previewPlaying ? (
                <div className="flex items-center gap-1.5 flex-shrink-0 text-accent">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
                  <span className="text-xs font-medium">Playing</span>
                </div>
              ) : (
                <div
                  className="relative flex-shrink-0 overflow-hidden rounded-full"
                  style={{ width: 48, height: 48 }}
                  onClick={() => setPreviewPlaying(true)}
                >
                  <iframe
                    src={`https://open.spotify.com/embed/track/${previewTrackId}?utm_source=generator&theme=0`}
                    width="320"
                    height="152"
                    frameBorder="0"
                    allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                    style={{ position: "absolute", bottom: 0, right: 0, opacity: 0.01 }}
                  />
                  <div className="absolute inset-0 flex items-center justify-center bg-accent rounded-full pointer-events-none">
                    <svg className="w-5 h-5 text-black ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z"/>
                    </svg>
                  </div>
                </div>
              )}
            </div>

            {/* Action buttons */}
            <div className="px-4 pb-4 space-y-2">
              {previewTrackData && (
                <button
                  onClick={() => {
                    requestSong(previewTrackData);
                    setPreviewTrackId(null);
                    setPreviewTrackInfo(null);
                    setPreviewTrackData(null);
                  }}
                  className="w-full py-2.5 bg-accent text-black font-semibold text-sm rounded-xl hover:bg-accent/90 transition-colors"
                >
                  {room.requireApproval ? "Request Song" : "+ Add to Queue"}
                </button>
              )}
              <button
                onClick={() => { setPreviewTrackId(null); setPreviewTrackInfo(null); setPreviewTrackData(null); setPreviewPlaying(false); }}
                className="w-full py-2 text-white/50 text-sm font-medium hover:text-white/70 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
