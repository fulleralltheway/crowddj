"use client";

import { useState, useEffect, useCallback, useRef, Component, type ReactNode } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { QRCodeSVG } from "qrcode.react";
import { getSocket } from "@/lib/socket";
import { useAppHeight, useNetworkStatus } from "@/lib/pwa";

class DashboardErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div className="min-h-dvh flex items-center justify-center p-4">
          <div className="text-center space-y-4 max-w-md">
            <p className="text-2xl font-bold">Something went wrong</p>
            <p className="text-text-secondary text-sm break-all">{this.state.error.message}</p>
            <button
              onClick={() => { this.setState({ error: null }); window.location.reload(); }}
              className="px-6 py-2.5 bg-accent hover:bg-accent-hover text-black font-semibold rounded-xl transition-colors"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

type Playlist = {
  id: string;
  name: string;
  images: { url: string }[];
  tracks: { total: number };
};

type Room = {
  id: string;
  code: string;
  name: string;
  playlistName: string;
  isActive: boolean;
  votesPerUser: number;
  voteResetMinutes: number;
  requireApproval: boolean;
  votingPaused: boolean;
  maxSongsPerGuest: number;
  explicitFilter: boolean;
  autoShuffle: boolean;
  queueDisplaySize: number;
  allowDuplicates: boolean;
  lastPreQueuedId: string | null;
  maxSongDurationSec: number;
  blockedArtists: string;
  blockedSongs: string;
  scheduledStart: string | null;
  brandColor: string;
  brandName: string;
  totalSongsPlayed: number;
  totalVotesCast: number;
  peakGuestCount: number;
  createdAt: string;
  songs: any[];
};

type SongRequest = {
  id: string;
  spotifyUri: string;
  trackName: string;
  artistName: string;
  albumArt: string | null;
  requestedByName?: string;
};

function NumInput({ label, value, min, max, onSave }: { label: string; value: number; min: number; max: number; onSave: (v: number) => void }) {
  const [local, setLocal] = useState(String(value));
  useEffect(() => { setLocal(String(value)); }, [value]);
  return (
    <div>
      <label className="block text-sm font-medium text-text-secondary mb-1">{label}</label>
      <input
        type="text"
        inputMode="numeric"
        value={local}
        onChange={(e) => {
          setLocal(e.target.value.replace(/[^0-9]/g, ""));
        }}
        onBlur={() => {
          const num = Number(local) || 0;
          const clamped = Math.max(min, Math.min(max, num));
          setLocal(String(clamped));
          if (clamped !== value) onSave(clamped);
        }}
        onFocus={(e) => e.target.select()}
        className="w-full px-3 py-2 bg-bg-primary border border-border rounded-lg text-sm focus:outline-none focus:border-accent"
      />
    </div>
  );
}

function ToggleSwitch({ enabled, onToggle, label, description }: { enabled: boolean; onToggle: () => void; label: string; description?: string }) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {description && <p className="text-text-secondary text-xs">{description}</p>}
      </div>
      <button
        onClick={onToggle}
        className={`w-12 h-7 rounded-full transition-colors flex-shrink-0 flex items-center px-0.5 ${
          enabled ? "bg-accent" : "bg-border"
        }`}
      >
        <span
          className={`w-6 h-6 bg-white rounded-full transition-transform ${
            enabled ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}

function formatTime(ms: number) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function MiniPlayer({
  nowPlaying,
  isPlaying,
  progressMs,
  durationMs,
  progressSyncedAt,
  onTogglePlay,
  onSkip,
  onFadeSkip,
  onFadePause,
  onHardSkipDuringFade,
  controlsLocked,
  onToggleLock,
  isFading,
  fadeDurationSec,
  onCycleFadeDuration,
}: {
  nowPlaying: any;
  isPlaying: boolean;
  progressMs: number;
  durationMs: number;
  progressSyncedAt: number;
  onTogglePlay: () => void;
  onSkip: () => void;
  onFadeSkip: () => void;
  onFadePause: () => void;
  onHardSkipDuringFade: () => void;
  controlsLocked: boolean;
  onToggleLock: () => void;
  isFading: boolean;
  fadeDurationSec: number;
  onCycleFadeDuration: () => void;
}) {
  const [displayProgress, setDisplayProgress] = useState(progressMs);

  useEffect(() => {
    if (!isPlaying || !durationMs) {
      setDisplayProgress(progressMs);
      return;
    }
    // Tick every 500ms to smoothly interpolate progress
    const tick = () => {
      const elapsed = Date.now() - progressSyncedAt;
      setDisplayProgress(Math.min(progressMs + elapsed, durationMs));
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [progressMs, durationMs, isPlaying, progressSyncedAt]);

  const pct = durationMs > 0 ? Math.min((displayProgress / durationMs) * 100, 100) : 0;

  return (
    <div className="flex-shrink-0 px-4 pb-1 lg:px-6 safe-bottom relative">
      {/* Fade gradient above mini-player */}
      <div className="absolute -top-10 left-0 right-0 h-10 bg-gradient-to-t from-bg-primary to-transparent pointer-events-none z-10" />
      {nowPlaying && (
        <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 w-3/4 h-16 rounded-full blur-2xl opacity-30 pointer-events-none" style={{ background: 'radial-gradient(ellipse, var(--color-accent) 0%, transparent 70%)' }} />
      )}
      <div className="relative z-20 bg-bg-card border border-border rounded-2xl shadow-2xl overflow-hidden">
        {/* Fading indicator bar */}
        {isFading && (
          <div className="h-0.5 bg-accent/30 overflow-hidden">
            <div className="h-full bg-accent animate-pulse" style={{ width: "100%" }} />
          </div>
        )}
        <div className="flex items-center gap-3 p-3">
            {/* Album art */}
            {nowPlaying?.albumArt ? (
              <img src={nowPlaying.albumArt} alt="" className={`w-12 h-12 rounded-lg shadow-md flex-shrink-0 transition-opacity ${isFading ? "opacity-50" : ""}`} />
            ) : (
              <div className="w-12 h-12 rounded-lg bg-bg-card-hover flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                </svg>
              </div>
            )}
            {/* Track info + progress */}
            <div className="flex-1 min-w-0">
              {nowPlaying ? (
                <>
                  <p className="text-sm font-semibold truncate">{isFading ? "Fading out..." : nowPlaying.trackName}</p>
                  <p className="text-xs text-text-secondary truncate">{nowPlaying.artistName}</p>
                </>
              ) : (
                <p className="text-sm text-text-secondary">No song playing</p>
              )}
              {nowPlaying && durationMs > 0 && (
                <div className="flex items-center gap-2 mt-1.5">
                  <span className="text-[10px] text-text-secondary tabular-nums w-8 text-right">{formatTime(displayProgress)}</span>
                  <div className="flex-1 h-1 bg-border rounded-full overflow-hidden">
                    <div
                      className="h-full bg-accent rounded-full transition-[width] duration-500 ease-linear"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-text-secondary tabular-nums w-8">{formatTime(durationMs)}</span>
                </div>
              )}
            </div>
            {/* Controls */}
            <div className="flex items-center gap-1 flex-shrink-0">
              {/* Lock toggle */}
              <button
                onClick={onToggleLock}
                className={`flex flex-col items-center justify-center rounded-lg px-2 py-1 transition-colors ${
                  controlsLocked ? "text-yellow-500 bg-yellow-500/10" : "text-white/25 hover:text-white/50 hover:bg-white/[0.04]"
                }`}
                title={controlsLocked ? "Unlock controls" : "Lock controls"}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  {controlsLocked ? (
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 11V7a4 4 0 118 0m-4 8v2m-2 4h4a2 2 0 002-2v-6a2 2 0 00-2-2H10a2 2 0 00-2 2v6a2 2 0 002 2z" />
                  )}
                </svg>
                <span className="text-[8px] font-medium leading-tight mt-0.5">{controlsLocked ? "Locked" : "Lock"}</span>
              </button>

              <div className="w-px h-6 bg-white/[0.06] mx-0.5" />

              {/* Fade & Pause */}
              <button
                onClick={controlsLocked ? undefined : onFadePause}
                className={`flex flex-col items-center justify-center rounded-lg px-2 py-1 transition-colors ${
                  controlsLocked ? "opacity-30 cursor-not-allowed" : "text-white/40 hover:text-white/70 hover:bg-white/[0.04]"
                }`}
                disabled={controlsLocked || isFading}
                title="Fade out and pause"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
                  <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
                </svg>
                <span className="text-[8px] font-medium leading-tight mt-0.5">Fade</span>
              </button>

              {/* Play/Pause — main control, larger */}
              <button
                onClick={controlsLocked ? undefined : onTogglePlay}
                className={`w-12 h-12 rounded-xl flex items-center justify-center transition-colors ${
                  controlsLocked ? "opacity-30 cursor-not-allowed" : "bg-white/[0.06] hover:bg-white/[0.1] active:bg-white/[0.15]"
                }`}
                disabled={controlsLocked}
                title={isPlaying ? "Pause" : "Play"}
              >
                {isPlaying ? (
                  <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24">
                    <rect x="6" y="4" width="4" height="16" rx="1" />
                    <rect x="14" y="4" width="4" height="16" rx="1" />
                  </svg>
                ) : (
                  <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>

              {/* Skip — fade skip by default, hard skip if already fading */}
              <button
                onClick={controlsLocked ? undefined : (isFading ? onHardSkipDuringFade : onFadeSkip)}
                className={`flex flex-col items-center justify-center rounded-lg px-2 py-1 transition-colors ${
                  controlsLocked ? "opacity-30 cursor-not-allowed" : isFading ? "text-accent bg-accent/10" : "text-white/40 hover:text-white/70 hover:bg-white/[0.04]"
                }`}
                disabled={controlsLocked}
                title={isFading ? "Skip now (hard skip)" : `Fade skip (${fadeDurationSec}s fade)`}
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M5 4v16l10-8zm12 0v16h2V4z" />
                </svg>
                <span className="text-[8px] font-medium leading-tight mt-0.5">{isFading ? "Skip!" : `Skip ${fadeDurationSec}s`}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
  );
}

export default function DashboardClient({ user }: { user: any }) {
  return (
    <DashboardErrorBoundary>
      <DashboardInner user={user} />
    </DashboardErrorBoundary>
  );
}

function DashboardInner({ user }: { user: any }) {
  useAppHeight();
  const isOnline = useNetworkStatus();
  const [view, setView] = useState<"loading" | "rooms" | "create" | "manage">("loading");
  const [rooms, setRooms] = useState<Room[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [activeRoom, setActiveRoom] = useState<Room | null>(null);
  const [requests, setRequests] = useState<SongRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [playError, setPlayError] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [progressMs, setProgressMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const progressSyncedAt = useRef(0); // local timestamp when progressMs was last set from server
  const [showSettings, setShowSettings] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [guestCount, setGuestCount] = useState(0);
  const [spotifyTrack, setSpotifyTrack] = useState<{ uri: string; name: string; artist: string; albumArt: string | null } | null>(null);
  const prevSpotifyUri = useRef<string | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<{ songId: string; name: string } | null>(null);
  const [songMenuOpen, setSongMenuOpen] = useState<string | null>(null);
  const [skipRemoveConfirm, setSkipRemoveConfirm] = useState(() => {
    if (typeof window === "undefined") return false;
    const ts = localStorage.getItem("skipRemoveConfirm_ts");
    if (ts && Date.now() - Number(ts) > 86400000) {
      localStorage.removeItem("skipRemoveConfirm");
      localStorage.removeItem("skipRemoveConfirm_ts");
      return false;
    }
    return localStorage.getItem("skipRemoveConfirm") === "true";
  });
  const [confirmReorder, setConfirmReorder] = useState<{ songs: any[]; movedSongId: string } | null>(null);
  const [skipReorderConfirm, setSkipReorderConfirm] = useState(() => {
    if (typeof window === "undefined") return false;
    const ts = localStorage.getItem("skipReorderConfirm_ts");
    if (ts && Date.now() - Number(ts) > 86400000) {
      localStorage.removeItem("skipReorderConfirm");
      localStorage.removeItem("skipReorderConfirm_ts");
      return false;
    }
    return localStorage.getItem("skipReorderConfirm") === "true";
  });
  const [confirmClose, setConfirmClose] = useState(false);
  const [searchStatus, setSearchStatus] = useState("");
  const [recentlyAdded, setRecentlyAdded] = useState<Set<string>>(new Set());
  const [songAddedToast, setSongAddedToast] = useState("");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const prevRequestCount = useRef<number>(0);
  const [showGuests, setShowGuests] = useState(false);
  const [guestList, setGuestList] = useState<any[]>([]);
  const [selectedGuest, setSelectedGuest] = useState<any>(null);
  const [expandedGuestSection, setExpandedGuestSection] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [controlsLocked, setControlsLocked] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("pq_controls_locked") === "true";
  });
  const [isFading, setIsFading] = useState(false);
  const [fadeDurationSec, setFadeDurationSec] = useState(() => {
    if (typeof window === "undefined") return 3;
    const saved = localStorage.getItem("pq_fade_duration");
    return saved ? Number(saved) : 3;
  });
  const [previewTrackId, setPreviewTrackId] = useState<string | null>(null);
  const [previewTrackInfo, setPreviewTrackInfo] = useState<{ name: string; artist: string } | null>(null);
  const [songListRef] = useAutoAnimate({ duration: 300 });
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const pullStartY = useRef(0);
  const pullDistRef = useRef(0);
  const pullRefreshRef = useRef(false);
  const isDragging = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchBarRef = useRef<HTMLDivElement>(null);
  const deferredSongs = useRef<any[] | null>(null);
  const showSearchRef = useRef(false);
  const PULL_THRESHOLD = 50;

  // Create room form state
  const [roomName, setRoomName] = useState("");
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);
  const [votesPerUser, setVotesPerUser] = useState(5);
  const [voteResetMinutes, setVoteResetMinutes] = useState(30);
  const [requireApproval, setRequireApproval] = useState(false);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduledStart, setScheduledStart] = useState("");
  const [playlistSearch, setPlaylistSearch] = useState("");
  const [spotifyPlaylists, setSpotifyPlaylists] = useState<any[]>([]);
  const playlistSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Event recap modal state
  const [recapStats, setRecapStats] = useState<{ totalSongsPlayed: number; totalVotesCast: number; peakGuestCount: number; durationMinutes: number } | null>(null);

  // Keep search ref in sync; flush deferred songs when search closes
  useEffect(() => {
    showSearchRef.current = showSearch;
    if (!showSearch) {
      if (deferredSongs.current) {
        setActiveRoom((prev) => (prev ? { ...prev, songs: deferredSongs.current! } : null));
        deferredSongs.current = null;
      }
      setRecentlyAdded(new Set());
    }
  }, [showSearch]);

  const fetchRooms = useCallback(async () => {
    const res = await fetch("/api/rooms");
    if (res.ok) {
      const data = await res.json();
      setRooms(data);
      return data as Room[];
    }
    return [] as Room[];
  }, []);

  // On mount: if there's an active room, jump straight to managing it
  const hasAutoOpened = useRef(false);
  useEffect(() => {
    (async () => {
      const fetchedRooms = await fetchRooms();
      if (typeof window !== "undefined" && "Notification" in window) {
        setNotificationsEnabled(Notification.permission === "granted");
      }
      if (!hasAutoOpened.current) {
        hasAutoOpened.current = true;
        const active = fetchedRooms.find((r) => r.isActive);
        if (active) {
          // Inline manageRoom logic to avoid dependency on not-yet-defined function
          const res = await fetch(`/api/rooms/${active.code}`);
          if (res.ok) {
            const data = await res.json();
            setActiveRoom(data);
            setView("manage");
          } else {
            setView("rooms");
          }
        } else {
          setView("rooms");
        }
      }
    })();
  }, [fetchRooms]);

  // Socket.io + fallback polling for real-time updates when managing a room
  useEffect(() => {
    if (view !== "manage" || !activeRoom) return;
    const code = activeRoom.code;
    const needsApproval = activeRoom.requireApproval;

    // Socket.io: join room and listen for real-time updates
    const socket = getSocket();
    socket.emit("join-room", code);

    const handleSongsUpdate = (songs: any[]) => {
      if (showSearchRef.current) {
        deferredSongs.current = songs;
      } else {
        setActiveRoom((prev) => (prev ? { ...prev, songs } : null));
      }
    };
    const handleGuestCount = (count: number) => {
      setGuestCount(count);
    };
    const handleRequestReceived = () => {
      if (needsApproval) fetchRequests(code);
    };
    const handleRoomUpdate = (room: any) => {
      setActiveRoom((prev) => prev ? { ...prev, lastPreQueuedId: room.lastPreQueuedId } : null);
    };

    socket.on("songs-update", handleSongsUpdate);
    socket.on("guest-count", handleGuestCount);
    socket.on("request-received", handleRequestReceived);
    socket.on("room-update", handleRoomUpdate);

    // Fallback polling (slower when socket is connected, full speed when not)
    let pollCount = 0;
    let tabHidden = false;
    const onVisChange = () => { tabHidden = document.hidden; };
    document.addEventListener("visibilitychange", onVisChange);
    const interval = setInterval(async () => {
      if (tabHidden) return; // Skip polling when tab is backgrounded
      try {
        pollCount++;
        const syncRes = await fetch(`/api/rooms/${code}/sync`, { method: "POST" });
        if (syncRes.ok) {
          const syncData = await syncRes.json();
          if (syncData.spotifyPlaying !== undefined) {
            setIsPlaying(syncData.spotifyPlaying);
          } else if (syncData.playing === false || syncData.queueEmpty) {
            setIsPlaying(false);
          }
          if (typeof syncData.progressMs === "number" && typeof syncData.durationMs === "number") {
            setProgressMs(syncData.progressMs);
            setDurationMs(syncData.durationMs);
            progressSyncedAt.current = Date.now();
          }
          if (syncData.spotifyTrack) {
            setSpotifyTrack(syncData.spotifyTrack);
          }
        }
        if (!socket.connected) {
          refreshSongs(code);
          fetchGuestCount(code);
        }
        if (needsApproval) fetchRequests(code);
        // Periodically fetch full room state to keep lastPreQueuedId in sync
        if (pollCount % 6 === 0) {
          fetch(`/api/rooms/${code}`).then(async (res) => {
            if (res.ok) {
              const room = await res.json();
              setActiveRoom((prev) => prev ? { ...prev, lastPreQueuedId: room.lastPreQueuedId } : null);
            }
          }).catch(() => {});
        }
      } catch {}
    }, 5000);

    return () => {
      socket.emit("leave-room", code);
      socket.off("songs-update", handleSongsUpdate);
      socket.off("guest-count", handleGuestCount);
      socket.off("request-received", handleRequestReceived);
      socket.off("room-update", handleRoomUpdate);
      document.removeEventListener("visibilitychange", onVisChange);
      clearInterval(interval);
    };
  }, [view, activeRoom?.code, activeRoom?.requireApproval]);

  // When Spotify track changes, notify guests immediately via socket
  useEffect(() => {
    if (!spotifyTrack?.uri || !activeRoom?.code) return;
    if (prevSpotifyUri.current && prevSpotifyUri.current !== spotifyTrack.uri) {
      getSocket().emit("song-changed", activeRoom.code);
    }
    prevSpotifyUri.current = spotifyTrack.uri;
  }, [spotifyTrack?.uri, activeRoom?.code]);

  // Auto-transition: refs declared here, effect below after fadeSkipSong
  const autoTransitionFired = useRef(false);
  const autoTransitionUri = useRef<string | null>(null); // track which song triggered the transition
  const fadeSkipRef = useRef<() => void>(() => {});

  useEffect(() => {
    // Only reset when the track actually changes to a DIFFERENT song
    // AND only if the previous transition was for a different URI
    if (spotifyTrack?.uri && spotifyTrack.uri !== autoTransitionUri.current) {
      autoTransitionFired.current = false;
    }
  }, [spotifyTrack?.uri]);

  const fetchPlaylists = async () => {
    const res = await fetch("/api/spotify/playlists");
    if (res.ok) setPlaylists(await res.json());
  };

  const createRoom = async () => {
    if (!selectedPlaylist || !roomName.trim()) return;
    setLoading(true);
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playlistId: selectedPlaylist.id,
        playlistName: selectedPlaylist.name,
        name: roomName.trim(),
        votesPerUser,
        voteResetMinutes,
        requireApproval,
        ...(scheduleEnabled && scheduledStart ? { scheduledStart: new Date(scheduledStart).toISOString() } : {}),
      }),
    });
    if (res.ok) {
      // Notify guests of any previously active rooms that were auto-closed
      const prevActive = rooms.find((r) => r.isActive);
      if (prevActive) {
        getSocket().emit("room-closed", prevActive.code);
      }
      const room = await res.json();
      setActiveRoom(room);
      setView("manage");
      fetchRooms();
    }
    setLoading(false);
  };

  const manageRoom = async (room: Room) => {
    const res = await fetch(`/api/rooms/${room.code}`);
    if (res.ok) {
      const data = await res.json();
      setActiveRoom(data);
      setView("manage");
      if (data.requireApproval) fetchRequests(room.code);
      fetchGuestCount(room.code);
      // Check current playback state
      const syncRes = await fetch(`/api/rooms/${room.code}/sync`, { method: "POST" });
      if (syncRes.ok) {
        const syncData = await syncRes.json();
        setIsPlaying(!!syncData.spotifyPlaying);
        if (typeof syncData.progressMs === "number" && typeof syncData.durationMs === "number") {
          setProgressMs(syncData.progressMs);
          setDurationMs(syncData.durationMs);
          progressSyncedAt.current = Date.now();
        }
        if (syncData.spotifyTrack) {
          setSpotifyTrack(syncData.spotifyTrack);
        }
      }
    }
  };

  const prevSongCount = useRef<number>(0);
  const refreshSongs = async (code: string) => {
    const res = await fetch(`/api/rooms/${code}/songs`);
    if (res.ok) {
      const songs = await res.json();
      // Notify host of new songs added by guests
      if (notificationsEnabled && songs.length > prevSongCount.current && prevSongCount.current > 0) {
        try {
          const newSongs = songs.filter((s: any) => s.addedByName);
          const latest = newSongs[newSongs.length - 1];
          if (latest && songs.length > prevSongCount.current) {
            const diff = songs.length - prevSongCount.current;
            new Notification("New Song Added", {
              body: diff === 1
                ? `${latest.addedByName || "Someone"} added "${latest.trackName}"`
                : `${diff} new songs added to queue`,
              icon: latest.albumArt || undefined,
            });
          }
        } catch { /* notification not supported */ }
      }
      prevSongCount.current = songs.length;
      if (showSearchRef.current) {
        deferredSongs.current = songs;
      } else {
        setActiveRoom((prev) => (prev ? { ...prev, songs } : null));
      }
    }
  };

  const fetchRequests = async (code: string) => {
    const res = await fetch(`/api/rooms/${code}/requests`);
    if (res.ok) {
      const data = await res.json();
      // Notify host of new requests
      if (notificationsEnabled && data.length > prevRequestCount.current && prevRequestCount.current > 0) {
        try {
          const newCount = data.length - prevRequestCount.current;
          const newest = data[data.length - 1];
          new Notification("New Song Request", {
            body: newCount === 1
              ? `${newest?.requestedByName || "Someone"} requested "${newest?.trackName}"`
              : `${newCount} new song requests`,
            icon: newest?.albumArt || undefined,
          });
        } catch { /* notification not supported */ }
      }
      prevRequestCount.current = data.length;
      setRequests(data);
    }
  };

  const fetchGuestCount = async (code: string) => {
    const res = await fetch(`/api/rooms/${code}/guests`);
    if (res.ok) {
      const data = await res.json();
      setGuestCount(data.count);
    }
  };

  const fetchGuestDetails = async () => {
    if (!activeRoom) return;
    const res = await fetch(`/api/rooms/${activeRoom.code}/guests?detail=true`);
    if (res.ok) {
      const data = await res.json();
      setGuestList(data.guests || []);
    }
  };

  const pullRefresh = async () => {
    if (!activeRoom) return;
    const code = activeRoom.code;
    const [roomRes, songsRes, syncRes] = await Promise.all([
      fetch(`/api/rooms/${code}`),
      fetch(`/api/rooms/${code}/songs`),
      fetch(`/api/rooms/${code}/sync`, { method: "POST" }),
    ]);
    if (roomRes.ok) {
      const data = await roomRes.json();
      setActiveRoom(data);
      if (data.requireApproval) fetchRequests(code);
    }
    if (songsRes.ok) {
      const songs = await songsRes.json();
      setActiveRoom((prev) => (prev ? { ...prev, songs } : null));
    }
    if (syncRes.ok) {
      const syncData = await syncRes.json();
      setIsPlaying(!!syncData.spotifyPlaying);
      if (typeof syncData.progressMs === "number" && typeof syncData.durationMs === "number") {
        setProgressMs(syncData.progressMs);
        setDurationMs(syncData.durationMs);
        progressSyncedAt.current = Date.now();
      }
      if (syncData.spotifyTrack) {
        setSpotifyTrack(syncData.spotifyTrack);
      }
    }
    fetchGuestCount(code);
    if (showGuests) fetchGuestDetails();
  };

  // Pull-to-refresh: non-passive touch listeners to prevent native overscroll
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      // Don't start pull-to-refresh while dragging a song
      if (isDragging.current) { pullStartY.current = 0; return; }
      if (el.scrollTop <= 0) {
        pullStartY.current = e.touches[0].clientY;
      } else {
        pullStartY.current = 0;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (isDragging.current) return; // Disable during drag
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
        pullRefresh().finally(() => {
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
  }, [activeRoom?.code]);

  const handleRequest = async (requestId: string, action: "approve" | "reject") => {
    if (!activeRoom) return;
    await fetch(`/api/rooms/${activeRoom.code}/requests`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, action }),
    });
    fetchRequests(activeRoom.code);
    // Approved songs get added to the queue — notify all clients
    if (action === "approve") {
      getSocket().emit("request-handled", activeRoom.code);
    }
  };

  // Mutex to prevent rapid-tap race conditions on all playback controls
  const playbackBusy = useRef(false);

  const togglePlay = async () => {
    if (!activeRoom || playbackBusy.current) return;
    playbackBusy.current = true;
    setPlayError("");
    try {
      const res = await fetch(`/api/rooms/${activeRoom.code}/play`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setIsPlaying(data.action === "playing" || data.action === "resumed");
        getSocket().emit("song-skipped", activeRoom.code);
      } else {
        const data = await res.json();
        setPlayError(data.error || "Open Spotify on a device and try again.");
        setTimeout(() => setPlayError(""), 6000);
      }
      refreshSongs(activeRoom.code);
    } finally {
      playbackBusy.current = false;
    }
  };

  const skipSong = async () => {
    if (!activeRoom || playbackBusy.current) return;
    playbackBusy.current = true;
    setIsFading(false);
    setProgressMs(0);
    setDurationMs(0);
    try {
      await fetch(`/api/rooms/${activeRoom.code}/skip`, { method: "POST" });
      getSocket().emit("song-skipped", activeRoom.code);
      refreshSongs(activeRoom.code);
    } finally {
      playbackBusy.current = false;
    }
  };

  // Hard skip that bypasses the mutex — used ONLY when interrupting an in-progress fade
  const hardSkipDuringFade = async () => {
    if (!activeRoom) return;
    // The server-side fade is still running, but we do a hard skip to override it.
    // The fade's DB updates (mark played, set next playing) will either have already
    // happened or will fail harmlessly since we advance the queue here.
    setIsFading(false);
    setProgressMs(0);
    setDurationMs(0);
    try {
      await fetch(`/api/rooms/${activeRoom.code}/skip`, { method: "POST" });
      getSocket().emit("song-skipped", activeRoom.code);
      refreshSongs(activeRoom.code);
    } finally {
      playbackBusy.current = false;
    }
  };

  const fadeSkipSong = async () => {
    if (!activeRoom || isFading || playbackBusy.current) return;
    playbackBusy.current = true;
    setIsFading(true);
    try {
      const res = await fetch(`/api/rooms/${activeRoom.code}/fade-skip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fadeDurationMs: fadeDurationSec * 1000, mode: "skip" }),
      });
      if (!res.ok) throw new Error("Fade skip failed");
      getSocket().emit("song-skipped", activeRoom.code);
      refreshSongs(activeRoom.code);
    } catch {
      // Fall back to hard skip (bypasses mutex since we already hold it)
      playbackBusy.current = false;
      await skipSong();
    } finally {
      setIsFading(false);
      playbackBusy.current = false;
    }
  };

  const fadePause = async () => {
    if (!activeRoom || isFading || playbackBusy.current) return;
    playbackBusy.current = true;
    setIsFading(true);
    try {
      const res = await fetch(`/api/rooms/${activeRoom.code}/fade-skip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fadeDurationMs: fadeDurationSec * 1000, mode: "pause" }),
      });
      if (!res.ok) throw new Error("Fade pause failed");
      setIsPlaying(false);
    } catch {
      // Fall back to hard pause
      try {
        await fetch(`/api/rooms/${activeRoom.code}/play`, { method: "POST" });
        setIsPlaying(false);
      } catch {}
    } finally {
      setIsFading(false);
      playbackBusy.current = false;
    }
  };

  // Auto-transition effect: fade-skip when max song duration is reached
  fadeSkipRef.current = fadeSkipSong;
  // Track when maxSongDurationSec changes to avoid triggering on mid-song setting changes
  const prevMaxDurRef = useRef(activeRoom?.maxSongDurationSec ?? 0);
  const maxDurSkipUri = useRef<string | null>(null); // URI to skip auto-transition for (setting changed mid-song)
  useEffect(() => {
    const newMax = activeRoom?.maxSongDurationSec ?? 0;
    if (newMax !== prevMaxDurRef.current) {
      const oldMax = prevMaxDurRef.current;
      prevMaxDurRef.current = newMax;
      // If the new limit is lower than the old one and the song might already be past it,
      // skip auto-transition for the current song entirely
      if (newMax > 0 && (oldMax === 0 || newMax < oldMax) && spotifyTrack?.uri) {
        maxDurSkipUri.current = spotifyTrack.uri;
      }
    }
  }, [activeRoom?.maxSongDurationSec, spotifyTrack?.uri]);
  useEffect(() => {
    const maxDur = activeRoom?.maxSongDurationSec;
    if (!maxDur || maxDur <= 0 || !isPlaying || isFading) return;

    const maxMs = maxDur * 1000;
    // Account for fade duration so we start fading before the limit
    const triggerMs = Math.max(0, maxMs - fadeDurationSec * 1000);
    const id = setInterval(() => {
      if (autoTransitionFired.current) return;
      // Skip if setting was changed mid-song for this track (takes effect next song)
      if (maxDurSkipUri.current && maxDurSkipUri.current === spotifyTrack?.uri) return;
      const elapsed = Date.now() - progressSyncedAt.current;
      const currentProgress = progressMs + elapsed;
      // Skip if progress data is stale (>15s old) — wait for fresh sync
      if (elapsed > 15000) return;
      // Skip if progress seems unreasonable (e.g. stale data from previous song)
      if (progressMs > maxMs + 30000) return;
      if (currentProgress >= triggerMs) {
        autoTransitionFired.current = true;
        autoTransitionUri.current = spotifyTrack?.uri ?? null;
        fadeSkipRef.current();
      }
    }, 1000);

    return () => clearInterval(id);
  }, [activeRoom?.maxSongDurationSec, isPlaying, isFading, progressMs, fadeDurationSec, spotifyTrack?.uri]);

  const cycleFadeDuration = () => {
    // Cycle through presets: 1 → 3 → 5 → 8 → 12 → 1
    const presets = [1, 3, 5, 8, 12];
    const currentIdx = presets.indexOf(fadeDurationSec);
    const next = presets[(currentIdx + 1) % presets.length];
    setFadeDurationSec(next);
    localStorage.setItem("pq_fade_duration", String(next));
  };

  const toggleControlsLock = () => {
    setControlsLocked((prev) => {
      const next = !prev;
      localStorage.setItem("pq_controls_locked", String(next));
      return next;
    });
  };

  const closeRoom = async () => {
    if (!activeRoom) return;
    const code = activeRoom.code;
    const res = await fetch(`/api/rooms/${code}`, { method: "DELETE" });
    if (res.ok) {
      getSocket().emit("room-closed", code);
      const data = await res.json();
      if (data.stats) {
        setRecapStats(data.stats);
      }
      setActiveRoom(null);
      fetchRooms();
    }
  };

  const openPreview = (spotifyUri: string, name: string, artist: string) => {
    const id = spotifyUri.replace("spotify:track:", "");
    if (previewTrackId === id) {
      setPreviewTrackId(null);
      setPreviewTrackInfo(null);
    } else {
      setPreviewTrackId(id);
      setPreviewTrackInfo({ name, artist });
    }
  };

  const lockSong = async (songId: string, position?: number) => {
    if (!activeRoom) return;
    // Optimistic UI: toggle lock immediately
    setActiveRoom((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        songs: prev.songs.map((s: any) =>
          s.id === songId ? { ...s, isLocked: !s.isLocked } : s
        ),
      };
    });
    await fetch(`/api/rooms/${activeRoom.code}/lock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ songId, position: position || 1 }),
    });
    getSocket().emit("songs-reordered", activeRoom.code);
    refreshSongs(activeRoom.code);
  };

  const pinSong = async (songId: string, pin: boolean, position?: number) => {
    if (!activeRoom) return;
    // Optimistic UI
    setActiveRoom((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        songs: prev.songs.map((s: any) =>
          s.id === songId
            ? { ...s, isPinned: pin, pinnedPosition: pin ? (position ?? null) : null, isLocked: pin ? true : false }
            : s
        ),
      };
    });
    await fetch(`/api/rooms/${activeRoom.code}/pin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ songId, pin, position }),
    });
    getSocket().emit("songs-reordered", activeRoom.code);
    refreshSongs(activeRoom.code);
  };

  const removeSong = async (songId: string) => {
    if (!activeRoom) return;
    await fetch(`/api/rooms/${activeRoom.code}/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ songId }),
    });
    getSocket().emit("songs-reordered", activeRoom.code);
    refreshSongs(activeRoom.code);
  };

  const handleRemoveClick = (songId: string, songName: string) => {
    if (skipRemoveConfirm) {
      removeSong(songId);
    } else {
      setConfirmRemove({ songId, name: songName });
    }
  };

  // Drag-to-reorder state
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const dragSongs = useRef<any[]>([]);
  const dragStartY = useRef(0);
  const dragItemHeight = useRef(0);

  const commitReorder = async (songs: any[], movedSongId: string, forceLockOverride = false) => {
    if (!activeRoom) return;
    // Optimistically mark the moved song as locked
    setActiveRoom((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        songs: prev.songs.map((s: any) =>
          s.id === movedSongId ? { ...s, isLocked: true } : s
        ),
      };
    });
    const orderedIds = songs.filter((s: any) => !s.isPlaying).map((s: any) => s.id);
    await fetch(`/api/rooms/${activeRoom.code}/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedIds }),
    });
    // Lock the song: always lock if user confirmed "Move & Lock" (forceLockOverride),
    // otherwise only auto-lock songs with votes
    const movedSong = songs.find((s: any) => s.id === movedSongId);
    const hasVotes = movedSong && (movedSong.upvotes - movedSong.downvotes) !== 0;
    if (forceLockOverride || hasVotes || movedSong?.isLocked) {
      await fetch(`/api/rooms/${activeRoom.code}/lock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ songId: movedSongId, forceLock: true }),
      });
    }
    refreshSongs(activeRoom.code);
  };

  const saveOrder = (songs: any[], movedSongId: string) => {
    if (!activeRoom) return;
    const isAutoShuffle = activeRoom.autoShuffle ?? true;
    // Check if the moved song is already locked — if so, no warning needed
    const movedSong = songs.find((s: any) => s.id === movedSongId);
    if (isAutoShuffle && !movedSong?.isLocked && !skipReorderConfirm) {
      setConfirmReorder({ songs, movedSongId });
    } else {
      commitReorder(songs, movedSongId, isAutoShuffle && skipReorderConfirm);
    }
  };

  const saveSettings = async (settings: Partial<Room>) => {
    if (!activeRoom) return;
    const res = await fetch(`/api/rooms/${activeRoom.code}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    if (res.ok) {
      const updated = await res.json();
      setActiveRoom((prev) => prev ? { ...prev, ...updated } : null);
      getSocket().emit("room-settings-changed", activeRoom.code);
    }
  };

  const activeRoomRef = useRef(activeRoom);
  activeRoomRef.current = activeRoom;

  const searchSongs = useCallback(async (query: string) => {
    const room = activeRoomRef.current;
    if (!query.trim() || !room) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const res = await fetch(
        `/api/rooms/${room.code}/search?q=${encodeURIComponent(query)}`
      );
      if (res.ok) setSearchResults(await res.json());
    } catch {
      // Network error — ignore
    }
    setSearching(false);
  }, []);

  const onSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!value.trim()) {
      setSearchResults([]);
      return;
    }
    searchTimer.current = setTimeout(() => searchSongs(value), 300);
  }, [searchSongs]);

  const addSongToQueue = async (track: any) => {
    const room = activeRoomRef.current;
    if (!room) return;
    try {
      const res = await fetch(`/api/rooms/${room.code}/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...track, fingerprint: "host" }),
      });
      const data = await res.json();
      if (res.ok) {
        getSocket().emit("songs-reordered", room.code);
        refreshSongs(room.code);
        setShowSearch(false);
        onSearchChange("");
        setSongAddedToast(`"${track.trackName}" added to queue`);
        setTimeout(() => setSongAddedToast(""), 3000);
      } else {
        setSearchStatus(data.error || "Failed to add song");
      }
    } catch {
      setSearchStatus("Failed to add song");
    }
    setTimeout(() => setSearchStatus(""), 3000);
  };

  const roomUrl = activeRoom
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/room/${activeRoom.code}`
    : "";

  if (view === "loading") {
    return (
      <div className="min-h-dvh flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Rooms list view
  if (view === "rooms") {
    const pastRooms = rooms.filter((r) => !r.isActive);
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center px-4 select-none safe-top">
        <div className="max-w-sm w-full text-center space-y-6 lg:max-w-md lg:bg-bg-card/50 lg:backdrop-blur-xl lg:border lg:border-white/[0.06] lg:rounded-3xl lg:p-10 lg:shadow-[0_8px_32px_rgba(0,0,0,0.3)]">
          <div className="flex items-center gap-3 justify-center">
            {user.image && (
              <img src={user.image} alt="" className="w-10 h-10 rounded-full lg:w-14 lg:h-14" />
            )}
            <div className="text-left">
              <p className="font-medium lg:text-lg">{user.name}</p>
              <p className="text-text-secondary text-sm">Host Dashboard</p>
            </div>
          </div>
          <div className="space-y-3">
            <p className="text-text-secondary">No active room. Create one to get started.</p>
            <button
              onClick={() => {
                setView("create");
                fetchPlaylists();
              }}
              className="w-full py-3.5 bg-accent hover:bg-accent-hover text-black font-semibold rounded-xl transition-colors lg:py-4 lg:text-base lg:rounded-2xl"
            >
              Create Room
            </button>
          </div>

          {/* Past Events */}
          {pastRooms.length > 0 && (
            <div className="text-left space-y-2 pt-2">
              <p className="text-xs font-medium text-white/40 uppercase tracking-wider">Past Events</p>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {pastRooms.slice(0, 10).map((r) => {
                  const created = new Date(r.createdAt);
                  const durationMin = Math.round((Date.now() - created.getTime()) / 60000);
                  const durationStr = durationMin >= 60 ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}m` : `${durationMin}m`;
                  return (
                    <div key={r.id} className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3">
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-sm font-medium truncate">{r.name}</p>
                        <span className="text-white/20 text-[10px] tabular-nums">{created.toLocaleDateString()}</span>
                      </div>
                      <p className="text-white/30 text-xs mb-1.5">{r.playlistName}</p>
                      <div className="flex gap-3 text-[11px] text-white/40">
                        <span>{r.totalSongsPlayed || 0} songs</span>
                        <span>{r.totalVotesCast || 0} votes</span>
                        <span>{r.peakGuestCount || 0} peak guests</span>
                        <span>{durationStr}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Event recap modal */}
        {recapStats && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6">
            <div className="bg-bg-card border border-border rounded-2xl p-6 max-w-sm w-full space-y-5">
              <p className="font-semibold text-center text-lg">Session Recap</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-white/[0.04] rounded-xl p-3 text-center">
                  <p className="text-2xl font-bold tabular-nums">{recapStats.totalSongsPlayed}</p>
                  <p className="text-white/40 text-xs mt-0.5">Songs Played</p>
                </div>
                <div className="bg-white/[0.04] rounded-xl p-3 text-center">
                  <p className="text-2xl font-bold tabular-nums">{recapStats.totalVotesCast}</p>
                  <p className="text-white/40 text-xs mt-0.5">Votes Cast</p>
                </div>
                <div className="bg-white/[0.04] rounded-xl p-3 text-center">
                  <p className="text-2xl font-bold tabular-nums">{recapStats.peakGuestCount}</p>
                  <p className="text-white/40 text-xs mt-0.5">Peak Guests</p>
                </div>
                <div className="bg-white/[0.04] rounded-xl p-3 text-center">
                  <p className="text-2xl font-bold tabular-nums">
                    {recapStats.durationMinutes >= 60
                      ? `${Math.floor(recapStats.durationMinutes / 60)}h ${recapStats.durationMinutes % 60}m`
                      : `${recapStats.durationMinutes}m`}
                  </p>
                  <p className="text-white/40 text-xs mt-0.5">Duration</p>
                </div>
              </div>
              <button
                onClick={() => { setRecapStats(null); setView("rooms"); }}
                className="w-full py-2.5 bg-accent hover:bg-accent-hover text-black font-semibold rounded-xl transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Create room view
  if (view === "create") {
    const displayPlaylists = playlistSearch.trim()
      ? playlists.filter((pl) => pl.name.toLowerCase().includes(playlistSearch.toLowerCase()))
      : playlists;

    return (
      <div className="flex flex-col min-h-dvh max-w-2xl lg:max-w-3xl mx-auto select-none safe-top lg:min-h-0 lg:my-6 lg:bg-white/[0.03] lg:backdrop-blur-xl lg:border lg:border-white/[0.06] lg:rounded-3xl lg:shadow-[0_8px_32px_rgba(0,0,0,0.3)] lg:max-h-[calc(100dvh-3rem)]" style={{ height: 'var(--app-height, 100dvh)' }}>
        {/* Sticky Header */}
        <div className="flex-shrink-0 bg-gradient-to-b from-bg-card/90 to-bg-primary/80 backdrop-blur-xl border-b border-white/[0.06] z-[60]">
          <div className="flex items-center justify-between px-4 pt-4 pb-3">
            <button
              onClick={() => activeRoom ? setView("manage") : setView("rooms")}
              className="text-white/40 hover:text-white/70 flex items-center gap-1.5 transition-colors text-[13px]"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back
            </button>
            <h2 className="text-lg font-bold">New Room</h2>
            <div className="w-12" />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-none px-4 pt-4 pb-8">

          <div className="space-y-5">
            {/* Room Name */}
            <div>
              <label className="block text-xs font-medium text-white/40 uppercase tracking-wider mb-1.5">Room Name</label>
              <input
                type="text"
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
                placeholder="Friday Night Vibes"
                className="w-full px-4 py-3 bg-white/[0.06] border border-white/[0.08] rounded-xl focus:outline-none focus:border-accent/40 focus:bg-white/[0.08] transition-colors placeholder:text-white/20"
              />
            </div>

            {/* Playlist Selection */}
            <div>
              <label className="block text-xs font-medium text-white/40 uppercase tracking-wider mb-1.5">Playlist</label>

              {/* Selected playlist preview */}
              {selectedPlaylist && !playlistSearch.trim() && (
                <div className="flex items-center gap-3 p-3 mb-2 rounded-xl border border-accent/30 bg-accent/8">
                  {selectedPlaylist.images?.[0] && (
                    <img src={selectedPlaylist.images[0].url} alt="" className="w-14 h-14 rounded-lg shadow-md" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{selectedPlaylist.name}</p>
                    <p className="text-accent text-xs">{selectedPlaylist.tracks?.total || 0} tracks</p>
                  </div>
                  <button
                    onClick={() => setSelectedPlaylist(null)}
                    className="text-white/30 hover:text-white/60 p-1"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              )}

              {/* Search */}
              <div className="relative mb-2">
                <svg className="w-4 h-4 text-white/30 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  value={playlistSearch}
                  onChange={(e) => {
                    setPlaylistSearch(e.target.value);
                    if (playlistSearchTimer.current) clearTimeout(playlistSearchTimer.current);
                    if (e.target.value.trim()) {
                      playlistSearchTimer.current = setTimeout(async () => {
                        const res = await fetch(`/api/spotify/playlists/search?q=${encodeURIComponent(e.target.value.trim())}`);
                        if (res.ok) setSpotifyPlaylists(await res.json());
                      }, 400);
                    } else {
                      setSpotifyPlaylists([]);
                    }
                  }}
                  placeholder={selectedPlaylist ? "Change playlist..." : "Search Spotify playlists..."}
                  className="w-full pl-10 pr-4 py-2.5 bg-white/[0.06] border border-white/[0.08] rounded-xl text-sm focus:outline-none focus:border-accent/40 focus:bg-white/[0.08] transition-colors placeholder:text-white/20"
                />
              </div>

              {/* Playlist list */}
              {playlists.length === 0 && !playlistSearch ? (
                <div className="flex items-center justify-center py-8">
                  <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                  <span className="text-white/30 text-sm ml-2">Loading playlists...</span>
                </div>
              ) : (
                <div className="space-y-1.5 max-h-56 overflow-y-auto">
                  {playlistSearch.trim() && spotifyPlaylists.length > 0 && (
                    <>
                      <p className="text-white/30 text-[10px] font-semibold uppercase tracking-wider px-1 pt-1">Spotify Results</p>
                      {spotifyPlaylists.filter((pl: any) => pl).map((pl: any) => (
                        <button
                          key={pl.id}
                          onClick={() => { setSelectedPlaylist(pl); setPlaylistSearch(""); setSpotifyPlaylists([]); }}
                          className={`w-full flex items-center gap-3 p-2.5 rounded-xl border transition-colors text-left ${
                            selectedPlaylist?.id === pl.id
                              ? "border-accent/30 bg-accent/8"
                              : "border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.06]"
                          }`}
                        >
                          {pl.images?.[0] && (
                            <img src={pl.images[0].url} alt="" className="w-11 h-11 rounded-lg" />
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium truncate">{pl.name}</p>
                            <p className="text-white/30 text-xs">{pl.tracks?.total || 0} tracks{pl.owner?.display_name ? ` · ${pl.owner.display_name}` : ""}</p>
                          </div>
                          {selectedPlaylist?.id === pl.id && (
                            <svg className="w-4 h-4 text-accent flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                            </svg>
                          )}
                        </button>
                      ))}
                    </>
                  )}
                  {(!playlistSearch.trim() || displayPlaylists.length > 0) && (
                    <>
                      {playlistSearch.trim() && <p className="text-white/30 text-[10px] font-semibold uppercase tracking-wider px-1 pt-2">Your Playlists</p>}
                      {displayPlaylists.map((pl) => (
                        <button
                          key={pl.id}
                          onClick={() => setSelectedPlaylist(pl)}
                          className={`w-full flex items-center gap-3 p-2.5 rounded-xl border transition-colors text-left ${
                            selectedPlaylist?.id === pl.id
                              ? "border-accent/30 bg-accent/8"
                              : "border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.06]"
                          }`}
                        >
                          {pl.images?.[0] && (
                            <img src={pl.images[0].url} alt="" className="w-11 h-11 rounded-lg" />
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium truncate">{pl.name}</p>
                            <p className="text-white/30 text-xs">{pl.tracks.total} tracks</p>
                          </div>
                          {selectedPlaylist?.id === pl.id && (
                            <svg className="w-4 h-4 text-accent flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                            </svg>
                          )}
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Settings section */}
            <div className="pt-1">
              <p className="text-xs font-medium text-white/40 uppercase tracking-wider mb-3">Settings</p>
              <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl divide-y divide-white/[0.06]">
                {/* Votes per user */}
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm">Votes per user</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setVotesPerUser(Math.max(1, votesPerUser - 1))}
                      className="w-7 h-7 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] flex items-center justify-center text-white/50 transition-colors"
                    >-</button>
                    <span className="text-sm font-semibold w-6 text-center tabular-nums">{votesPerUser}</span>
                    <button
                      onClick={() => setVotesPerUser(Math.min(50, votesPerUser + 1))}
                      className="w-7 h-7 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] flex items-center justify-center text-white/50 transition-colors"
                    >+</button>
                  </div>
                </div>
                {/* Vote reset */}
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm">Vote reset</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setVoteResetMinutes(Math.max(5, voteResetMinutes - 5))}
                      className="w-7 h-7 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] flex items-center justify-center text-white/50 transition-colors"
                    >-</button>
                    <span className="text-sm font-semibold w-10 text-center tabular-nums">{voteResetMinutes}m</span>
                    <button
                      onClick={() => setVoteResetMinutes(Math.min(1440, voteResetMinutes + 5))}
                      className="w-7 h-7 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] flex items-center justify-center text-white/50 transition-colors"
                    >+</button>
                  </div>
                </div>
                {/* Require approval */}
                <div className="flex items-center justify-between px-4 py-3">
                  <div>
                    <p className="text-sm">Require approval</p>
                    <p className="text-white/30 text-xs">Review requests before adding</p>
                  </div>
                  <button
                    onClick={() => setRequireApproval(!requireApproval)}
                    className={`w-11 h-6 rounded-full transition-colors flex-shrink-0 flex items-center px-0.5 ${
                      requireApproval ? "bg-accent" : "bg-white/15"
                    }`}
                  >
                    <span
                      className={`w-5 h-5 bg-white rounded-full transition-transform shadow-sm ${
                        requireApproval ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>
              </div>
            </div>

            {/* Schedule start time */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl">
              <div className="px-4 py-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm">Schedule start time</p>
                    <p className="text-white/30 text-xs">Show countdown until start</p>
                  </div>
                  <button
                    onClick={() => setScheduleEnabled(!scheduleEnabled)}
                    className={`w-11 h-6 rounded-full transition-colors flex-shrink-0 flex items-center px-0.5 ${
                      scheduleEnabled ? "bg-accent" : "bg-white/15"
                    }`}
                  >
                    <span
                      className={`w-5 h-5 bg-white rounded-full transition-transform shadow-sm ${
                        scheduleEnabled ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>
                {scheduleEnabled && (
                  <input
                    type="datetime-local"
                    value={scheduledStart}
                    onChange={(e) => setScheduledStart(e.target.value)}
                    min={new Date().toISOString().slice(0, 16)}
                    className="w-full px-3 py-2 bg-white/[0.06] border border-white/[0.08] rounded-lg text-sm focus:outline-none focus:border-accent/40 transition-colors [color-scheme:dark]"
                  />
                )}
              </div>
            </div>

            {/* Create button */}
            <button
              onClick={createRoom}
              disabled={!roomName.trim() || !selectedPlaylist || loading || (scheduleEnabled && !scheduledStart)}
              className="w-full py-3.5 bg-accent hover:bg-accent-hover text-black font-semibold rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loading ? "Creating..." : scheduleEnabled ? "Schedule Room" : "Create Room"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Manage room view — prefer actual Spotify playback over queue's isPlaying flag
  const queuePlaying = activeRoom?.songs?.find((s: any) => s.isPlaying);
  const nowPlaying = spotifyTrack
    ? (queuePlaying && queuePlaying.spotifyUri === spotifyTrack.uri
      ? queuePlaying
      : { trackName: spotifyTrack.name, artistName: spotifyTrack.artist, albumArt: spotifyTrack.albumArt, spotifyUri: spotifyTrack.uri })
    : queuePlaying;

  return (
    <div className="flex flex-col max-w-6xl xl:max-w-7xl mx-auto overflow-hidden relative select-none safe-top lg:my-6 lg:bg-white/[0.03] lg:backdrop-blur-xl lg:border lg:border-white/[0.06] lg:rounded-3xl lg:shadow-[0_8px_32px_rgba(0,0,0,0.3)] lg:max-h-[calc(100dvh-3rem)]" style={{ height: 'var(--app-height, 100dvh)' }}>
      {!isOnline && (
        <div className="flex-shrink-0 bg-red-600 text-white text-center text-xs py-1 font-medium z-[70]">
          No internet connection
        </div>
      )}
      {/* Fixed header area */}
      <div className="flex-shrink-0 bg-gradient-to-b from-bg-card/90 to-bg-primary/80 backdrop-blur-xl border-b border-white/[0.06] relative z-[60]">
      <div className="px-4 pt-4 pb-3 lg:px-6 lg:pt-5">
        {/* Top bar: back + room code */}
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={() => setConfirmClose(true)}
            className="text-downvote/60 hover:text-downvote flex items-center gap-1.5 transition-colors text-[13px]"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
            End Session
          </button>
          <div className="flex items-center gap-2">
            {guestCount > 0 && (
              <button
                onClick={() => { setShowGuests(!showGuests); setShowQR(false); setShowSettings(false); setShowSearch(false); onSearchChange(""); if (!showGuests) fetchGuestDetails(); }}
                className={`flex items-center gap-1.5 text-[13px] px-2.5 py-1.5 rounded-xl transition-colors ${
                  showGuests ? "text-accent bg-accent/10" : "text-white/40 hover:text-white/70 hover:bg-white/5"
                }`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                {guestCount}
              </button>
            )}
            <button
              onClick={() => { setShowQR(!showQR); setShowSettings(false); setShowGuests(false); setSelectedGuest(null); setShowSearch(false); onSearchChange(""); }}
              className={`font-mono text-[13px] font-semibold px-3 py-1.5 rounded-xl transition-colors ${showQR ? "text-accent bg-accent/10 border border-accent/20" : "text-accent/70 bg-white/[0.04] border border-white/[0.08] hover:border-accent/20"}`}
            >
              {activeRoom?.code}
            </button>
          </div>
        </div>
      </div>

      {activeRoom && (
        <>
          {/* Room title + search */}
          <div className="px-4 pb-3 lg:px-6">
          {/* Room name */}
          <div className="mb-3">
            <h2 className="text-xl font-bold tracking-tight leading-tight lg:text-2xl">{activeRoom.name}</h2>
            <p className="text-white/30 text-[11px] mt-0.5">{activeRoom.playlistName}</p>
          </div>

          {/* Search bar + action buttons */}
          <div className="relative">
          <div className="flex gap-2">
            <div className="flex-1 relative" ref={searchBarRef}>
              <svg className="w-4 h-4 text-white/30 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                onFocus={() => { setShowSearch(true); setShowQR(false); setShowSettings(false); setShowGuests(false); setSelectedGuest(null); }}
                placeholder="Search queue or add songs..."
                className="w-full pl-10 pr-9 py-2.5 bg-white/[0.06] border border-white/[0.08] rounded-2xl text-sm placeholder:text-white/25 focus:outline-none focus:border-accent/40 focus:bg-white/[0.08] transition-colors"
              />
              {searchQuery ? (
                <button
                  onClick={() => {
                    onSearchChange("");
                    setShowSearch(false);
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-white/30 hover:text-white/60 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              ) : searching ? (
                <div className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 text-xs">...</div>
              ) : null}
            </div>
            {!showSearch && (
              <>
                <button
                  onClick={() => { setShowQR(!showQR); setShowSettings(false); setShowGuests(false); setSelectedGuest(null); }}
                  className={`p-2.5 rounded-2xl transition-colors ${
                    showQR ? "bg-accent/10 text-accent border border-accent/20" : "bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-white/40"
                  }`}
                  title="Share Room"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                  </svg>
                </button>
                <button
                  onClick={() => { setShowSettings(!showSettings); setShowQR(false); setShowGuests(false); setSelectedGuest(null); }}
                  className={`p-2.5 rounded-2xl transition-colors ${
                    showSettings ? "bg-accent/10 text-accent border border-accent/20" : "bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-white/40"
                  }`}
                  title="Settings"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </button>
              </>
            )}
          </div>
          {/* Search results rendered as fixed overlay — see below */}
          </div>
          </div>
        </>
      )}
      </div>

      {activeRoom && (
        <>
          {/* Scrollable content area */}
          <div
            ref={scrollRef}
            className={`flex-1 overflow-y-auto overscroll-none px-4 pt-4 pb-20 lg:px-6 relative z-10 transition-opacity duration-200 ${showSearch ? "opacity-30 pointer-events-none" : ""}`}
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

          <div className={`${(showQR || showSettings || showGuests) ? "lg:grid lg:grid-cols-[1fr_1.5fr] lg:gap-6 xl:gap-8" : ""}`}>
          {/* Left column: Now Playing, Controls, Panels */}
          <div className={`${!(showQR || showSettings || showGuests) ? "lg:hidden" : ""}`}>

          {/* Song added toast */}
          {songAddedToast && (
            <div className="mb-3 px-4 py-2 bg-accent/10 border border-accent/20 rounded-xl text-sm text-center text-accent animate-pulse">
              {songAddedToast}
            </div>
          )}

          {/* Play error toast */}
          {playError && (
            <div className="mb-3 px-4 py-2 bg-downvote/10 border border-downvote/20 rounded-xl text-sm text-center text-downvote">
              {playError}
            </div>
          )}

          {/* QR Code / Share panel */}
          {showQR && (
            <div className="bg-bg-card border border-border rounded-xl p-6 mb-4 flex flex-col items-center">
              <QRCodeSVG
                value={roomUrl}
                size={160}
                bgColor="transparent"
                fgColor="#ffffff"
                level="M"
              />
              <p className="text-text-secondary text-sm mt-3">Scan to join</p>
              <p className="font-mono text-2xl text-accent font-bold mt-1 select-text">{activeRoom.code}</p>
              <div className="flex items-center gap-3 mt-3">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(roomUrl);
                    setLinkCopied(true);
                    setTimeout(() => setLinkCopied(false), 2000);
                  }}
                  className="px-4 py-2 bg-accent/15 text-accent text-sm font-medium rounded-lg hover:bg-accent/25 transition-colors"
                >
                  {linkCopied ? "Copied!" : "Copy Link"}
                </button>
                {typeof navigator !== "undefined" && "share" in navigator && (
                  <button
                    onClick={() => navigator.share({ title: `Join ${activeRoom?.name}`, text: `Vote on songs at ${activeRoom?.name}!`, url: roomUrl })}
                    className="px-4 py-2 bg-bg-card-hover text-white text-sm font-medium rounded-lg hover:bg-border transition-colors"
                  >
                    Share
                  </button>
                )}
              </div>
              <button
                onClick={() => window.open(`/room/${activeRoom.code}/display`, '_blank')}
                className="mt-3 flex items-center justify-center gap-2 px-4 py-2 w-full bg-bg-card-hover text-text-secondary text-sm font-medium rounded-lg hover:bg-border hover:text-white transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                TV Display Mode
              </button>
            </div>
          )}

          {/* Guest list panel */}
          {showGuests && (
            <div className="bg-bg-card border border-border rounded-xl mb-4 overflow-hidden">
              <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                <p className="text-sm font-semibold">{guestList.length} Guest{guestList.length !== 1 ? "s" : ""}</p>
                <button onClick={() => { setShowGuests(false); setSelectedGuest(null); }} className="text-text-secondary hover:text-white p-1">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {selectedGuest ? (
                <div className="p-4">
                  <button onClick={() => { setSelectedGuest(null); setExpandedGuestSection(null); }} className="text-accent text-xs mb-3 hover:text-accent-hover">&larr; Back to list</button>
                  <p className="font-semibold text-lg">{selectedGuest.name}</p>
                  <p className="text-text-secondary text-xs mb-3">Joined {new Date(selectedGuest.joinedAt).toLocaleTimeString()}</p>
                  {(() => {
                    const sections = [
                      { key: "totalVotes", label: "Total Votes", value: selectedGuest.totalVotes, color: "text-accent", border: "border-accent/30" },
                      { key: "upvotes", label: "Upvotes", value: selectedGuest.totalUpvotes, color: "text-upvote", border: "border-upvote/30" },
                      { key: "downvotes", label: "Downvotes", value: selectedGuest.totalDownvotes, color: "text-downvote", border: "border-downvote/30" },
                      { key: "activeVotes", label: "Active Votes", value: selectedGuest.activeVotes?.length || 0, color: "text-blue-400", border: "border-blue-400/30" },
                      { key: "songsAdded", label: "Songs Added", value: selectedGuest.songsAdded?.length || 0, color: "text-purple-400", border: "border-purple-400/30" },
                      { key: "requests", label: "Requests", value: selectedGuest.requests?.length || 0, color: "text-yellow-500", border: "border-yellow-500/30" },
                    ];
                    return (
                      <>
                        <div className="grid grid-cols-3 gap-2 mb-4">
                          {sections.map((sec) => (
                            <button
                              key={sec.key}
                              onClick={() => setExpandedGuestSection((prev: string | null) => prev === sec.key ? null : sec.key)}
                              className={`bg-bg-primary rounded-lg p-2 text-center transition-colors border ${
                                expandedGuestSection === sec.key ? sec.border : "border-transparent"
                              }`}
                            >
                              <p className={`text-lg font-bold ${sec.color}`}>{sec.value}</p>
                              <p className="text-[10px] text-text-secondary">{sec.label}</p>
                            </button>
                          ))}
                        </div>

                        {/* Expanded section content */}
                        {expandedGuestSection === "activeVotes" && selectedGuest.activeVotes?.length > 0 && (
                          <div className="mb-3 space-y-1 max-h-48 overflow-y-auto">
                            {selectedGuest.activeVotes.map((v: any, i: number) => (
                              <div key={i} className="flex items-center gap-2 py-1.5 px-2 rounded-lg bg-bg-primary">
                                <span className={`text-sm ${v.value === 1 ? "text-upvote" : "text-downvote"}`}>
                                  {v.value === 1 ? "\u25B2" : "\u25BC"}
                                </span>
                                {v.albumArt && <img src={v.albumArt} alt="" className="w-7 h-7 rounded" />}
                                <div className="min-w-0 flex-1">
                                  <p className="text-xs font-medium truncate">{v.trackName}</p>
                                  <p className="text-[10px] text-text-secondary truncate">{v.artistName}</p>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        {expandedGuestSection === "songsAdded" && selectedGuest.songsAdded?.length > 0 && (
                          <div className="mb-3 space-y-1 max-h-48 overflow-y-auto">
                            {selectedGuest.songsAdded.map((s: any, i: number) => (
                              <div key={i} className="flex items-center gap-2 py-1.5 px-2 rounded-lg bg-bg-primary">
                                {s.albumArt && <img src={s.albumArt} alt="" className="w-7 h-7 rounded" />}
                                <div className="min-w-0 flex-1">
                                  <p className="text-xs font-medium truncate">{s.trackName}</p>
                                  <p className="text-[10px] text-text-secondary truncate">{s.artistName}</p>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        {expandedGuestSection === "requests" && selectedGuest.requests?.length > 0 && (
                          <div className="mb-3 space-y-1 max-h-48 overflow-y-auto">
                            {selectedGuest.requests.map((r: any, i: number) => (
                              <div key={i} className="flex items-center gap-2 py-1.5 px-2 rounded-lg bg-bg-primary">
                                {r.albumArt && <img src={r.albumArt} alt="" className="w-7 h-7 rounded" />}
                                <div className="min-w-0 flex-1">
                                  <p className="text-xs font-medium truncate">{r.trackName}</p>
                                  <p className="text-[10px] text-text-secondary truncate">{r.artistName}</p>
                                </div>
                                <span className={`text-[10px] font-medium flex-shrink-0 ${
                                  r.status === "approved" ? "text-upvote" : r.status === "rejected" ? "text-downvote" : "text-yellow-500"
                                }`}>
                                  {r.status}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}

                        {selectedGuest.activeVotes?.length === 0 && selectedGuest.songsAdded?.length === 0 && selectedGuest.requests?.length === 0 && (
                          <p className="text-text-secondary text-xs text-center py-2">No activity yet</p>
                        )}
                      </>
                    );
                  })()}
                </div>
              ) : (
                <div className="max-h-64 overflow-y-auto divide-y divide-border/50">
                  {guestList.length === 0 ? (
                    <p className="p-4 text-text-secondary text-sm text-center">No guests yet</p>
                  ) : (
                    guestList.map((g: any) => (
                      <button
                        key={g.id}
                        onClick={() => { setSelectedGuest(g); setExpandedGuestSection(null); }}
                        className="w-full flex items-center justify-between px-4 py-3 hover:bg-bg-card-hover transition-colors text-left"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{g.name || "Anonymous"}</p>
                          <p className="text-text-secondary text-[10px]">
                            {g.totalVotes} vote{g.totalVotes !== 1 ? "s" : ""}
                            {g.songsAdded?.length > 0 && ` · ${g.songsAdded.length} added`}
                            {g.requests?.length > 0 && ` · ${g.requests.length} req`}
                          </p>
                        </div>
                        <svg className="w-4 h-4 text-text-secondary flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}

          {/* Settings panel */}
          {showSettings && (
            <div className="mb-4 p-4 bg-bg-card border border-border rounded-xl space-y-4">
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">Room Name</label>
                <input
                  type="text"
                  defaultValue={activeRoom.name}
                  onBlur={(e) => {
                    const val = e.target.value.trim();
                    if (val && val !== activeRoom.name) saveSettings({ name: val } as any);
                  }}
                  className="w-full px-3 py-2 bg-bg-primary border border-border rounded-lg text-sm focus:outline-none focus:border-accent"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <NumInput
                  label="Votes per User"
                  value={activeRoom.votesPerUser}
                  min={1}
                  max={50}
                  onSave={(v) => saveSettings({ votesPerUser: v } as any)}
                />
                <NumInput
                  label="Vote Reset (min)"
                  value={activeRoom.voteResetMinutes}
                  min={5}
                  max={1440}
                  onSave={(v) => saveSettings({ voteResetMinutes: v } as any)}
                />
              </div>
              <NumInput
                label="Song Requests per Guest (0 = unlimited)"
                value={activeRoom.maxSongsPerGuest ?? 0}
                min={0}
                max={50}
                onSave={(v) => saveSettings({ maxSongsPerGuest: v } as any)}
              />
              <NumInput
                label="Queue Display Size"
                value={activeRoom.queueDisplaySize ?? 50}
                min={10}
                max={500}
                onSave={(v) => saveSettings({ queueDisplaySize: v } as any)}
              />
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">
                  Max Song Duration (seconds)
                </label>
                <p className="text-[11px] text-white/30 mb-1.5">0 = full length. Auto-fades to next song at this time.</p>
                <div className="flex gap-2">
                  {[0, 60, 90, 120, 180].map((sec) => (
                    <button
                      key={sec}
                      onClick={() => saveSettings({ maxSongDurationSec: sec } as any)}
                      className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors ${
                        (activeRoom.maxSongDurationSec ?? 0) === sec
                          ? "bg-accent/20 text-accent border border-accent/30"
                          : "bg-bg-primary border border-border text-text-secondary hover:bg-bg-card-hover"
                      }`}
                    >
                      {sec === 0 ? "Full" : `${sec}s`}
                    </button>
                  ))}
                </div>
                <NumInput
                  label="Custom (seconds)"
                  value={activeRoom.maxSongDurationSec ?? 0}
                  min={0}
                  max={600}
                  onSave={(v) => saveSettings({ maxSongDurationSec: v } as any)}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">
                  Fade Duration (seconds)
                </label>
                <p className="text-[11px] text-white/30 mb-1.5">How long the volume fades out before transitioning.</p>
                <div className="flex gap-2">
                  {[1, 3, 5, 8, 12].map((sec) => (
                    <button
                      key={sec}
                      onClick={() => {
                        setFadeDurationSec(sec);
                        localStorage.setItem("pq_fade_duration", String(sec));
                      }}
                      className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors ${
                        fadeDurationSec === sec
                          ? "bg-accent/20 text-accent border border-accent/30"
                          : "bg-bg-primary border border-border text-text-secondary hover:bg-bg-card-hover"
                      }`}
                    >
                      {sec}s
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={fadeDurationSec}
                    onChange={(e) => {
                      const val = Math.max(1, Math.min(30, Number(e.target.value) || 1));
                      setFadeDurationSec(val);
                      localStorage.setItem("pq_fade_duration", String(val));
                    }}
                    className="w-20 px-3 py-2 bg-bg-primary border border-border rounded-lg text-sm text-center focus:outline-none focus:border-accent"
                  />
                  <span className="text-text-secondary text-xs">seconds (1–30)</span>
                </div>
              </div>
              <ToggleSwitch
                enabled={activeRoom.requireApproval}
                onToggle={() => saveSettings({ requireApproval: !activeRoom.requireApproval } as any)}
                label="Require Approval"
                description="Approve requests before adding"
              />
              <ToggleSwitch
                enabled={activeRoom.votingPaused ?? false}
                onToggle={() => saveSettings({ votingPaused: !(activeRoom.votingPaused ?? false) } as any)}
                label="Pause Voting"
                description="Temporarily disable guest voting"
              />
              <ToggleSwitch
                enabled={activeRoom.explicitFilter ?? false}
                onToggle={() => saveSettings({ explicitFilter: !(activeRoom.explicitFilter ?? false) } as any)}
                label="Explicit Filter"
                description="Block explicit songs from being added"
              />
              <ToggleSwitch
                enabled={activeRoom.autoShuffle ?? true}
                onToggle={() => saveSettings({ autoShuffle: !(activeRoom.autoShuffle ?? true) } as any)}
                label="Auto-Shuffle by Votes"
                description="Reorder queue based on vote scores"
              />
              <ToggleSwitch
                enabled={activeRoom.allowDuplicates ?? false}
                onToggle={() => saveSettings({ allowDuplicates: !(activeRoom.allowDuplicates ?? false) } as any)}
                label="Allow Replays"
                description="Let songs be added again after being played"
              />
              <ToggleSwitch
                enabled={notificationsEnabled}
                onToggle={async () => {
                  if (notificationsEnabled) {
                    setNotificationsEnabled(false);
                  } else if ("Notification" in window) {
                    const perm = await Notification.requestPermission();
                    setNotificationsEnabled(perm === "granted");
                  }
                }}
                label="Notifications"
                description="Get notified when guests add or request songs"
              />
              {/* Block List */}
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">Blocked Artists</label>
                <p className="text-[11px] text-white/30 mb-1.5">Guests cannot request songs by these artists.</p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const input = (e.target as HTMLFormElement).elements.namedItem("blockedArtistInput") as HTMLInputElement;
                    const val = input.value.trim();
                    if (!val) return;
                    const current = (activeRoom.blockedArtists || "").split(",").map((s) => s.trim()).filter(Boolean);
                    if (current.some((a) => a.toLowerCase() === val.toLowerCase())) { input.value = ""; return; }
                    const updated = [...current, val].join(",");
                    saveSettings({ blockedArtists: updated } as any);
                    input.value = "";
                  }}
                >
                  <input
                    name="blockedArtistInput"
                    type="text"
                    placeholder="Type artist name + Enter"
                    className="w-full px-3 py-2 bg-bg-primary border border-border rounded-lg text-sm focus:outline-none focus:border-accent"
                  />
                </form>
                {(activeRoom.blockedArtists || "").split(",").filter((a) => a.trim()).length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {(activeRoom.blockedArtists || "").split(",").map((a) => a.trim()).filter(Boolean).map((artist) => (
                      <span
                        key={artist}
                        className="inline-flex items-center gap-1 px-2.5 py-1 bg-downvote/10 text-downvote/80 border border-downvote/20 rounded-full text-xs"
                      >
                        {artist}
                        <button
                          onClick={() => {
                            const current = (activeRoom.blockedArtists || "").split(",").map((s) => s.trim()).filter(Boolean);
                            const updated = current.filter((a) => a.toLowerCase() !== artist.toLowerCase()).join(",");
                            saveSettings({ blockedArtists: updated } as any);
                          }}
                          className="ml-0.5 hover:text-downvote transition-colors"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {/* Branding */}
              <div className="border-t border-border pt-4">
                <label className="block text-sm font-medium text-text-secondary mb-1">Branding</label>
                <p className="text-[11px] text-white/30 mb-3">Customize how guests see your room.</p>
                <div className="mb-3">
                  <label className="block text-xs font-medium text-text-secondary mb-1">Custom Display Name</label>
                  <input
                    type="text"
                    defaultValue={activeRoom.brandName || ""}
                    placeholder={activeRoom.name}
                    onBlur={(e) => {
                      const val = e.target.value.trim();
                      if (val !== (activeRoom.brandName || "")) saveSettings({ brandName: val } as any);
                    }}
                    className="w-full px-3 py-2 bg-bg-primary border border-border rounded-lg text-sm focus:outline-none focus:border-accent"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1">Accent Color</label>
                  <div className="flex flex-wrap gap-2 mb-2">
                    {[
                      { label: "Green", hex: "#1db954" },
                      { label: "Blue", hex: "#3b82f6" },
                      { label: "Purple", hex: "#8b5cf6" },
                      { label: "Pink", hex: "#ec4899" },
                      { label: "Red", hex: "#ef4444" },
                      { label: "Orange", hex: "#f97316" },
                      { label: "Yellow", hex: "#eab308" },
                    ].map(({ label, hex }) => (
                      <button
                        key={hex}
                        title={label}
                        onClick={() => saveSettings({ brandColor: hex } as any)}
                        className={`w-8 h-8 rounded-full border-2 transition-all ${
                          (activeRoom.brandColor || "#1db954") === hex
                            ? "border-white scale-110"
                            : "border-transparent hover:border-white/40"
                        }`}
                        style={{ backgroundColor: hex }}
                      />
                    ))}
                    <button
                      onClick={() => saveSettings({ brandColor: "" } as any)}
                      className="px-3 h-8 rounded-full border border-border text-xs text-text-secondary hover:bg-bg-card-hover transition-colors"
                    >
                      Reset
                    </button>
                  </div>
                  {activeRoom.brandColor && (
                    <div className="flex items-center gap-2 mt-2 text-xs text-text-secondary">
                      <span
                        className="w-3 h-3 rounded-full inline-block"
                        style={{ backgroundColor: activeRoom.brandColor }}
                      />
                      Guests will see this accent color
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          </div>
          {/* Right column: Pending Requests + Queue */}
          <div>

          {/* Pending Requests */}
          {activeRoom.requireApproval && requests.length > 0 && (
            <div className="mb-6">
              <h3 className="text-lg font-semibold mb-3">
                Pending Requests ({requests.length})
              </h3>
              <div className="space-y-2">
                {requests.map((req) => (
                  <div
                    key={req.id}
                    className="flex items-center gap-3 p-3 bg-bg-card border border-border rounded-xl"
                  >
                    <button
                      onClick={() => openPreview(req.spotifyUri, req.trackName, req.artistName)}
                      className={`relative w-10 h-10 rounded-lg flex-shrink-0 overflow-hidden group ${previewTrackId === req.spotifyUri.replace("spotify:track:", "") ? "ring-2 ring-accent" : ""}`}
                    >
                      {req.albumArt && <img src={req.albumArt} alt="" className="w-full h-full object-cover" />}
                      <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                        <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                      </div>
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{req.trackName}</p>
                      <p className="text-text-secondary text-xs truncate">{req.artistName}</p>
                      {req.requestedByName && (
                        <p className="text-accent text-xs truncate">{req.requestedByName}</p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleRequest(req.id, "approve")}
                        className="p-2 bg-upvote/20 text-upvote rounded-lg hover:bg-upvote/30 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      </button>
                      <button
                        onClick={() => handleRequest(req.id, "reject")}
                        className="p-2 bg-downvote/20 text-downvote rounded-lg hover:bg-downvote/30 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Song Queue */}
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-semibold">Queue</h3>
            <span className="text-white/25 text-xs">{(activeRoom.songs?.filter((s: any) => !s.isPlaying) || []).length} songs</span>
          </div>
          {(() => {
            const pinnedCount = (activeRoom.songs || []).filter((s: any) => s.isPinned && !s.isPlaying && !s.isPlayed).length;
            if (pinnedCount === 0) return null;
            return (
              <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg border border-blue-400/15 bg-blue-400/5">
                <svg className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
                </svg>
                <span className="text-blue-400 text-xs font-medium">{pinnedCount} song{pinnedCount !== 1 ? "s" : ""} pinned</span>
              </div>
            );
          })()}
          <div ref={dragIdx === null ? songListRef : undefined} className={`space-y-1.5 pb-8 ${!(showQR || showSettings || showGuests) ? "lg:grid lg:grid-cols-2 lg:gap-3 lg:space-y-0" : ""}`}>
            {(() => {
              const queueSongs = activeRoom.songs?.filter((s: any) => !s.isPlaying) || [];
              // Build display order: if dragging, show reordered preview
              const displaySongs = dragIdx !== null && overIdx !== null && dragIdx !== overIdx
                ? (() => {
                    const arr = [...queueSongs];
                    const [moved] = arr.splice(dragIdx, 1);
                    arr.splice(overIdx, 0, moved);
                    return arr;
                  })()
                : queueSongs;

              return displaySongs.map((song: any, i: number) => (
                <div
                  key={song.id}
                  className={`flex items-center gap-2.5 p-3 border rounded-xl song-card transition-all ${
                    song.isPinned
                      ? "border-blue-400/20 bg-blue-400/5"
                      : song.isLocked && activeRoom.lastPreQueuedId === song.id
                      ? "border-accent/30 bg-accent/8"
                      : song.isLocked
                      ? "border-yellow-500/20 bg-yellow-500/5"
                      : "border-white/[0.06] bg-white/[0.03]"
                  } ${dragIdx !== null && overIdx === i ? "ring-2 ring-accent/40" : ""}`}
                >
                  {/* Drag handle */}
                  <div
                    className="cursor-grab active:cursor-grabbing touch-none select-none p-1 -ml-1"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      isDragging.current = true;
                      // Capture pointer to prevent browser touch actions (pull-to-refresh, scroll)
                      (e.target as HTMLElement).setPointerCapture(e.pointerId);
                      // Measure the parent card element (the song row), not the small handle
                      const card = e.currentTarget.parentElement as HTMLElement;
                      const rect = card?.getBoundingClientRect();
                      dragItemHeight.current = rect?.height ?? 64;
                      dragStartY.current = e.clientY;
                      dragSongs.current = [...queueSongs];
                      setDragIdx(i);
                      setOverIdx(i);

                      // Auto-scroll the scroll container when dragging near edges
                      let scrollRAF = 0;
                      let lastPointerY = e.clientY;
                      const EDGE_ZONE = 80; // px from top/bottom to trigger scroll
                      const MAX_SCROLL_SPEED = 6; // px per frame at edge — keep it slow so drag tracks
                      const scrollEl = scrollRef.current;

                      const autoScroll = () => {
                        if (!scrollEl) { scrollRAF = requestAnimationFrame(autoScroll); return; }
                        const rect = scrollEl.getBoundingClientRect();
                        const distFromTop = lastPointerY - rect.top;
                        const distFromBottom = rect.bottom - lastPointerY;

                        let scrollDelta = 0;
                        if (distFromTop < EDGE_ZONE && distFromTop >= 0) {
                          const intensity = 1 - distFromTop / EDGE_ZONE;
                          scrollDelta = -Math.ceil(MAX_SCROLL_SPEED * intensity);
                        } else if (distFromBottom < EDGE_ZONE && distFromBottom >= 0) {
                          const intensity = 1 - distFromBottom / EDGE_ZONE;
                          scrollDelta = Math.ceil(MAX_SCROLL_SPEED * intensity);
                        }

                        if (scrollDelta !== 0) {
                          const before = scrollEl.scrollTop;
                          scrollEl.scrollBy(0, scrollDelta);
                          const actual = scrollEl.scrollTop - before; // how much it really scrolled
                          // Adjust baseline so the held item follows the scroll
                          dragStartY.current -= actual;
                          // Recalculate index
                          const delta = lastPointerY - dragStartY.current;
                          const off = Math.round(delta / (dragItemHeight.current + 8));
                          const newIdx = Math.max(0, Math.min(queueSongs.length - 1, i + off));
                          setOverIdx(newIdx);
                        }
                        scrollRAF = requestAnimationFrame(autoScroll);
                      };
                      scrollRAF = requestAnimationFrame(autoScroll);

                      const onMove = (ev: PointerEvent) => {
                        lastPointerY = ev.clientY;
                        const delta = ev.clientY - dragStartY.current;
                        const offset = Math.round(delta / (dragItemHeight.current + 8));
                        const newIdx = Math.max(0, Math.min(queueSongs.length - 1, i + offset));
                        setOverIdx(newIdx);
                      };

                      const onUp = (ev: PointerEvent) => {
                        isDragging.current = false;
                        cancelAnimationFrame(scrollRAF);
                        try { (ev.target as HTMLElement).releasePointerCapture(ev.pointerId); } catch {}
                        window.removeEventListener("pointermove", onMove);
                        window.removeEventListener("pointerup", onUp);
                        // Commit reorder
                        setDragIdx((prevDrag) => {
                          setOverIdx((prevOver) => {
                            if (prevDrag !== null && prevOver !== null && prevDrag !== prevOver) {
                              const arr = [...dragSongs.current];
                              const movedSong = arr[prevDrag];
                              const [moved] = arr.splice(prevDrag, 1);
                              arr.splice(prevOver, 0, moved);
                              setActiveRoom((prev) => {
                                if (!prev) return null;
                                const playing = prev.songs?.filter((s: any) => s.isPlaying) || [];
                                return { ...prev, songs: [...playing, ...arr] };
                              });
                              saveOrder(arr, movedSong.id);
                            }
                            return null;
                          });
                          return null;
                        });
                      };

                      window.addEventListener("pointermove", onMove);
                      window.addEventListener("pointerup", onUp);
                    }}
                  >
                    <svg className="w-3.5 h-3.5 text-white/20" viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="9" cy="7" r="1.5" />
                      <circle cx="15" cy="7" r="1.5" />
                      <circle cx="9" cy="12" r="1.5" />
                      <circle cx="15" cy="12" r="1.5" />
                      <circle cx="9" cy="17" r="1.5" />
                      <circle cx="15" cy="17" r="1.5" />
                    </svg>
                  </div>

                  <span className="text-white/30 text-xs w-4 text-center flex-shrink-0 font-medium">
                    {song.isPinned ? (
                      <svg className="w-3.5 h-3.5 text-blue-400 mx-auto" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
                      </svg>
                    ) : song.isLocked && activeRoom.lastPreQueuedId !== song.id ? (
                      <svg className="w-3.5 h-3.5 text-yellow-500 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                      </svg>
                    ) : (
                      i + 1
                    )}
                  </span>
                  {song.albumArt && (
                    <img src={song.albumArt} alt="" className="w-11 h-11 rounded-lg flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    {song.isPinned && (
                      <p className="text-[10px] font-semibold text-blue-400 uppercase tracking-wider">Pinned #{song.pinnedPosition != null ? song.pinnedPosition + 1 : i + 1}</p>
                    )}
                    {song.isLocked && !song.isPinned && activeRoom.lastPreQueuedId === song.id && (
                      <p className="text-[10px] font-semibold text-accent uppercase tracking-wider">Queued Next</p>
                    )}
                    <p className="font-medium text-sm truncate">{song.trackName}</p>
                    <p className="text-text-secondary text-xs truncate">{song.artistName}</p>
                    {song.addedByName && (
                      <p className="text-accent text-xs truncate">Req&apos;d by {song.addedByName?.split(" ")[0] || song.addedByName}</p>
                    )}
                    {/* BPM / Energy badges — desktop only */}
                    {(song.tempo || song.energy !== null) && (
                      <div className="hidden lg:flex items-center gap-1.5 mt-0.5">
                        {song.tempo != null && (
                          <span className="text-[10px] text-white/30 font-medium tabular-nums">{Math.round(song.tempo)} BPM</span>
                        )}
                        {song.energy != null && (
                          <span className={`inline-block w-1.5 h-1.5 rounded-full ${song.energy >= 0.7 ? "bg-green-500" : song.energy >= 0.4 ? "bg-yellow-500" : "bg-red-500"}`} title={`Energy: ${Math.round(song.energy * 100)}%`} />
                        )}
                        {song.danceability != null && (
                          <span className="text-[10px] text-white/20 tabular-nums">{Math.round(song.danceability * 100)}% dance</span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {/* Preview button — desktop only */}
                    {/* Preview button — desktop only */}
                    <button
                      onClick={() => openPreview(song.spotifyUri, song.trackName, song.artistName)}
                      className={`hidden lg:flex w-7 h-7 rounded-lg items-center justify-center transition-colors ${previewTrackId === song.spotifyUri.replace("spotify:track:", "") ? "text-accent bg-accent/10" : "text-white/20 hover:text-white/40 hover:bg-white/[0.04]"}`}
                      title="Preview"
                    >
                      {previewTrackId === song.spotifyUri.replace("spotify:track:", "") ? (
                        <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                          <rect x="6" y="4" width="4" height="16" rx="1" />
                          <rect x="14" y="4" width="4" height="16" rx="1" />
                        </svg>
                      ) : (
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072M17.95 6.05a8 8 0 010 11.9M6.5 8.5l5-4v15l-5-4H4a1 1 0 01-1-1v-5a1 1 0 011-1h2.5z" />
                        </svg>
                      )}
                    </button>
                    {!(song.isLocked && activeRoom.lastPreQueuedId !== song.id) && (
                      <div className="text-right mr-0.5">
                        {(() => {
                          const net = song.upvotes - song.downvotes;
                          const hasVotes = song.upvotes > 0 || song.downvotes > 0;
                          const hasMixed = song.upvotes > 0 && song.downvotes > 0;
                          return (
                            <>
                              <span className={`text-sm font-semibold tabular-nums ${net > 0 ? "text-upvote" : net < 0 ? "text-downvote" : "text-white/20"}`}>
                                {hasVotes ? (net > 0 ? `+${net}` : net) : "\u00B7"}
                              </span>
                              {hasMixed && (
                                <p className="text-[10px] text-white/30">
                                  <span className="text-upvote/60">{song.upvotes}&#x2191;</span>
                                  {" "}
                                  <span className="text-downvote/60">{song.downvotes}&#x2193;</span>
                                </p>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    )}
                    {/* Overflow menu */}
                    <div className="relative">
                      <button
                        onClick={() => setSongMenuOpen(songMenuOpen === song.id ? null : song.id)}
                        className={`p-1.5 rounded-lg transition-colors ${songMenuOpen === song.id ? "text-white/60 bg-white/[0.08]" : "text-white/20 hover:text-white/40 hover:bg-white/[0.04]"}`}
                      >
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                          <circle cx="12" cy="6" r="1.5" />
                          <circle cx="12" cy="12" r="1.5" />
                          <circle cx="12" cy="18" r="1.5" />
                        </svg>
                      </button>
                      {songMenuOpen === song.id && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setSongMenuOpen(null)} />
                          <div className="absolute right-0 top-full mt-1 z-50 bg-bg-card border border-white/[0.1] rounded-xl shadow-2xl overflow-hidden min-w-[140px]">
                            <button
                              onClick={() => { openPreview(song.spotifyUri, song.trackName, song.artistName); setSongMenuOpen(null); }}
                              className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm hover:bg-white/[0.06] transition-colors text-left"
                            >
                              <svg className={`w-4 h-4 ${previewTrackId === song.spotifyUri.replace("spotify:track:", "") ? "text-accent" : "text-white/40"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
                                {previewTrackId === song.spotifyUri.replace("spotify:track:", "") ? (
                                  <><rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" /></>
                                ) : (
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072M17.95 6.05a8 8 0 010 11.9M6.5 8.5l5-4v15l-5-4H4a1 1 0 01-1-1v-5a1 1 0 011-1h2.5z" />
                                )}
                              </svg>
                              <span className={previewTrackId === song.spotifyUri.replace("spotify:track:", "") ? "text-accent" : ""}>{previewTrackId === song.spotifyUri.replace("spotify:track:", "") ? "Stop Preview" : "Preview"}</span>
                            </button>
                            <button
                              onClick={() => { lockSong(song.id); setSongMenuOpen(null); }}
                              className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm hover:bg-white/[0.06] transition-colors text-left"
                            >
                              <svg className={`w-4 h-4 ${song.isLocked ? "text-yellow-500" : "text-white/40"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
                                {song.isLocked ? (
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 11V7a4 4 0 118 0m-4 8v2m-2 4h4a2 2 0 002-2v-6a2 2 0 00-2-2H10a2 2 0 00-2 2v6a2 2 0 002 2z" />
                                ) : (
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                                )}
                              </svg>
                              <span className={song.isLocked ? "text-yellow-500" : ""}>{song.isLocked ? "Unlock" : "DJ Lock"}</span>
                            </button>
                            <button
                              onClick={() => { pinSong(song.id, !song.isPinned, i); setSongMenuOpen(null); }}
                              className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm hover:bg-white/[0.06] transition-colors text-left"
                            >
                              <svg className={`w-4 h-4 ${song.isPinned ? "text-blue-400" : "text-white/40"}`} fill="currentColor" viewBox="0 0 24 24">
                                <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
                              </svg>
                              <span className={song.isPinned ? "text-blue-400" : ""}>{song.isPinned ? "Unpin" : "Pin to Position"}</span>
                            </button>
                            <button
                              onClick={() => { handleRemoveClick(song.id, song.trackName); setSongMenuOpen(null); }}
                              className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm hover:bg-downvote/10 transition-colors text-left text-downvote/80"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                              Remove
                            </button>
                            <button
                              onClick={() => {
                                const artist = song.artistName?.trim();
                                if (!artist) { setSongMenuOpen(null); return; }
                                const current = (activeRoom.blockedArtists || "").split(",").map((s: string) => s.trim()).filter(Boolean);
                                if (!current.some((a: string) => a.toLowerCase() === artist.toLowerCase())) {
                                  saveSettings({ blockedArtists: [...current, artist].join(",") } as any);
                                }
                                setSongMenuOpen(null);
                              }}
                              className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm hover:bg-downvote/10 transition-colors text-left text-downvote/80"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                              </svg>
                              Block Artist
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ));
            })()}
          </div>

          {/* Remove confirmation modal */}
          {confirmRemove && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6">
              <div className="bg-bg-card border border-border rounded-2xl p-6 max-w-sm w-full space-y-4">
                <p className="font-semibold text-center">Remove song?</p>
                <p className="text-text-secondary text-sm text-center truncate">
                  {confirmRemove.name}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setConfirmRemove(null)}
                    className="flex-1 py-2.5 bg-bg-card-hover border border-border rounded-xl text-sm font-medium transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      removeSong(confirmRemove.songId);
                      setConfirmRemove(null);
                    }}
                    className="flex-1 py-2.5 bg-downvote text-white rounded-xl text-sm font-semibold transition-colors"
                  >
                    Remove
                  </button>
                </div>
                <label className="flex items-center gap-2 justify-center cursor-pointer">
                  <input
                    type="checkbox"
                    className="rounded"
                    onChange={(e) => {
                      setSkipRemoveConfirm(e.target.checked);
                      localStorage.setItem("skipRemoveConfirm", String(e.target.checked));
                      if (e.target.checked) localStorage.setItem("skipRemoveConfirm_ts", String(Date.now()));
                    }}
                  />
                  <span className="text-text-secondary text-xs">Don&apos;t ask again</span>
                </label>
              </div>
            </div>
          )}

          {/* Reorder override confirmation modal */}
          {confirmReorder && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6">
              <div className="bg-bg-card border border-border rounded-2xl p-6 max-w-sm w-full space-y-4">
                <p className="font-semibold text-center">Override auto-shuffle?</p>
                <p className="text-text-secondary text-sm text-center">
                  Moving this song manually will override the vote-based ordering. The song will be locked in its new position.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setConfirmReorder(null);
                      refreshSongs(activeRoom!.code);
                    }}
                    className="flex-1 py-2.5 bg-bg-card-hover border border-border rounded-xl text-sm font-medium transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      commitReorder(confirmReorder.songs, confirmReorder.movedSongId, true);
                      setConfirmReorder(null);
                    }}
                    className="flex-1 py-2.5 bg-accent text-black rounded-xl text-sm font-semibold transition-colors"
                  >
                    Move &amp; Lock
                  </button>
                </div>
                <label className="flex items-center gap-2 justify-center cursor-pointer">
                  <input
                    type="checkbox"
                    className="rounded"
                    onChange={(e) => {
                      setSkipReorderConfirm(e.target.checked);
                      localStorage.setItem("skipReorderConfirm", String(e.target.checked));
                      if (e.target.checked) localStorage.setItem("skipReorderConfirm_ts", String(Date.now()));
                    }}
                  />
                  <span className="text-text-secondary text-xs">Don&apos;t ask again</span>
                </label>
              </div>
            </div>
          )}

          {/* Close room confirmation modal */}
          {confirmClose && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6">
              <div className="bg-bg-card border border-border rounded-2xl p-6 max-w-sm w-full space-y-4">
                <p className="font-semibold text-center">End this session?</p>
                <p className="text-text-secondary text-sm text-center">
                  This will close the room and disconnect all guests. You can create a new room anytime.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setConfirmClose(false)}
                    className="flex-1 py-2.5 bg-bg-card-hover border border-border rounded-xl text-sm font-medium transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      setConfirmClose(false);
                      closeRoom();
                    }}
                    className="flex-1 py-2.5 bg-downvote text-white rounded-xl text-sm font-semibold transition-colors"
                  >
                    End Session
                  </button>
                </div>
              </div>
            </div>
          )}

          </div>
          </div>
          </div>

          {/* Floating mini-player bar */}
          <MiniPlayer
            nowPlaying={nowPlaying}
            isPlaying={isPlaying}
            progressMs={progressMs}
            durationMs={durationMs}
            progressSyncedAt={progressSyncedAt.current}
            onTogglePlay={togglePlay}
            onSkip={skipSong}
            onFadeSkip={fadeSkipSong}
            onFadePause={fadePause}
            onHardSkipDuringFade={hardSkipDuringFade}
            controlsLocked={controlsLocked}
            onToggleLock={toggleControlsLock}
            isFading={isFading}
            fadeDurationSec={fadeDurationSec}
            onCycleFadeDuration={cycleFadeDuration}
          />
        </>
      )}

      {/* Fixed search results overlay — rendered outside all stacking contexts */}
      {showSearch && searchQuery && (searchResults.length > 0 || searching) && (() => {
        const rect = searchBarRef.current?.getBoundingClientRect();
        if (!rect) return null;
        return (
          <>
          <div className="fixed inset-0" style={{ zIndex: 9998 }} onClick={() => { setShowSearch(false); onSearchChange(""); }} />
          <div
            className="fixed bg-bg-card border border-border rounded-xl overflow-hidden shadow-2xl"
            style={{
              top: rect.bottom + 4,
              left: rect.left,
              right: window.innerWidth - rect.right,
              zIndex: 9999,
            }}
          >
            <div className="max-h-72 overflow-y-auto divide-y divide-border/50">
              {/* Queue matches */}
              {(() => {
                const q = searchQuery.toLowerCase();
                const queueSongs = (activeRoom?.songs || []).filter((s: any) => !s.isPlaying);
                const queueMatches = queueSongs.filter((s: any) =>
                  s.trackName.toLowerCase().includes(q) ||
                  s.artistName.toLowerCase().includes(q)
                );
                if (queueMatches.length === 0) return null;
                return (
                  <div className="p-2 space-y-1">
                    <p className="text-text-secondary text-[10px] font-semibold uppercase tracking-wider px-1">In Queue</p>
                    {queueMatches.map((song: any) => {
                      const queueIdx = queueSongs.findIndex((s: any) => s.id === song.id);
                      return (
                        <div key={song.id} className={`flex items-center gap-3 p-2 rounded-lg ${song.isLocked ? "bg-yellow-500/5" : ""}`}>
                          {song.albumArt && (
                            <img src={song.albumArt} alt="" className="w-9 h-9 rounded-md" />
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{song.trackName}</p>
                            <p className="text-text-secondary text-xs truncate">
                              {song.artistName} &middot; #{queueIdx + 1} in queue
                            </p>
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <select
                              className="bg-bg-primary border border-border rounded-lg text-xs px-1.5 py-1 focus:outline-none focus:border-accent"
                              value=""
                              onChange={(e) => {
                                const targetPos = Number(e.target.value);
                                if (!targetPos || !activeRoom) return;
                                const arr = [...queueSongs];
                                const fromIdx = arr.findIndex((s: any) => s.id === song.id);
                                const [moved] = arr.splice(fromIdx, 1);
                                arr.splice(targetPos - 1, 0, moved);
                                setActiveRoom((prev) => {
                                  if (!prev) return null;
                                  const playing = prev.songs?.filter((s: any) => s.isPlaying) || [];
                                  return { ...prev, songs: [...playing, ...arr] };
                                });
                                saveOrder(arr, song.id);
                                setShowSearch(false);
                                onSearchChange("");
                                setSongAddedToast(`"${song.trackName}" moved to #${targetPos}`);
                                setTimeout(() => setSongAddedToast(""), 3000);
                              }}
                            >
                              <option value="">Move to...</option>
                              {queueSongs.map((_: any, idx: number) => (
                                <option key={idx} value={idx + 1}>#{idx + 1}</option>
                              ))}
                            </select>
                            <button
                              onClick={() => lockSong(song.id)}
                              className={`p-1.5 rounded-lg text-xs transition-colors ${
                                song.isLocked
                                  ? "bg-yellow-500/20 text-yellow-500"
                                  : "bg-bg-card-hover text-text-secondary hover:text-white"
                              }`}
                              title={song.isLocked ? "Unlock" : "Lock"}
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
                                {song.isLocked ? (
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 10.5V6.75a4.5 4.5 0 1 1 9 0v3.75M3.75 21.75h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H3.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
                                ) : (
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
                                )}
                              </svg>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

              {searchResults.length > 0 && (
                <div className="p-2 space-y-1">
                  <p className="text-text-secondary text-[10px] font-semibold uppercase tracking-wider px-1">From Spotify</p>
                  {searchResults.map((track: any) => {
                    const inQueue = (activeRoom?.songs || []).some(
                      (s: any) => s.spotifyUri === track.spotifyUri
                    );
                    const justAdded = recentlyAdded.has(track.spotifyUri);
                    const unavailable = inQueue || justAdded;
                    return (
                      <button
                        key={track.spotifyUri}
                        onClick={() => !unavailable && addSongToQueue(track)}
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
                        <span className={`text-xs font-medium ${unavailable ? "text-upvote" : "text-accent"}`}>
                          {justAdded ? "Added!" : inQueue ? "In queue" : "+ Add"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {searching && (
                <div className="p-3 text-center text-text-secondary text-xs">Searching...</div>
              )}
            </div>
            {searchStatus && (
              <div className="px-3 py-2 border-t border-border/50 text-center text-xs text-accent">{searchStatus}</div>
            )}
          </div>
          </>
        );
      })()}

      {/* Spotify Embed Preview Modal */}
      {previewTrackId && (
        <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center" onClick={() => { setPreviewTrackId(null); setPreviewTrackInfo(null); }}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div
            className="relative w-full max-w-sm mx-4 mb-4 sm:mb-0 rounded-2xl overflow-hidden shadow-2xl bg-[#181818] border border-white/[0.08]"
            onClick={(e) => e.stopPropagation()}
          >
            {previewTrackInfo && (
              <div className="flex items-center justify-between px-4 pt-3 pb-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-white truncate">{previewTrackInfo.name}</p>
                  <p className="text-xs text-white/50 truncate">{previewTrackInfo.artist}</p>
                </div>
                <button
                  onClick={() => { setPreviewTrackId(null); setPreviewTrackInfo(null); }}
                  className="ml-3 w-7 h-7 flex items-center justify-center rounded-full bg-white/[0.08] hover:bg-white/[0.15] text-white/60 hover:text-white transition-colors flex-shrink-0"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            )}
            <iframe
              src={`https://open.spotify.com/embed/track/${previewTrackId}?utm_source=generator&theme=0`}
              width="100%"
              height="152"
              frameBorder="0"
              allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
              loading="lazy"
              className="rounded-b-2xl"
            />
          </div>
        </div>
      )}
    </div>
  );
}
