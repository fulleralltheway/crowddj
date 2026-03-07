"use client";

import { useState, useEffect, useCallback, useRef, Component, type ReactNode } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { QRCodeSVG } from "qrcode.react";

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
  songs: any[];
};

type SongRequest = {
  id: string;
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
          const raw = e.target.value.replace(/[^0-9]/g, "");
          setLocal(raw === "" ? "" : String(Number(raw)));
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

export default function DashboardClient({ user }: { user: any }) {
  return (
    <DashboardErrorBoundary>
      <DashboardInner user={user} />
    </DashboardErrorBoundary>
  );
}

function DashboardInner({ user }: { user: any }) {
  const [view, setView] = useState<"rooms" | "create" | "manage">("rooms");
  const [rooms, setRooms] = useState<Room[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [activeRoom, setActiveRoom] = useState<Room | null>(null);
  const [requests, setRequests] = useState<SongRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [playError, setPlayError] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [guestCount, setGuestCount] = useState(0);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<{ songId: string; name: string } | null>(null);
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
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const prevRequestCount = useRef<number>(0);
  const [showGuests, setShowGuests] = useState(false);
  const [guestList, setGuestList] = useState<any[]>([]);
  const [selectedGuest, setSelectedGuest] = useState<any>(null);
  const [expandedGuestSection, setExpandedGuestSection] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [songListRef] = useAutoAnimate({ duration: 300 });

  // Create room form state
  const [roomName, setRoomName] = useState("");
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);
  const [votesPerUser, setVotesPerUser] = useState(5);
  const [voteResetMinutes, setVoteResetMinutes] = useState(30);
  const [requireApproval, setRequireApproval] = useState(false);

  const fetchRooms = useCallback(async () => {
    const res = await fetch("/api/rooms");
    if (res.ok) setRooms(await res.json());
  }, []);

  useEffect(() => {
    fetchRooms();
    if (typeof window !== "undefined" && "Notification" in window) {
      setNotificationsEnabled(Notification.permission === "granted");
    }
  }, [fetchRooms]);

  // Poll for song/request updates and auto-advance when managing a room
  useEffect(() => {
    if (view !== "manage" || !activeRoom) return;
    const code = activeRoom.code;
    const needsApproval = activeRoom.requireApproval;
    const interval = setInterval(async () => {
      try {
        const syncRes = await fetch(`/api/rooms/${code}/sync`, { method: "POST" });
        if (syncRes.ok) {
          const syncData = await syncRes.json();
          if (syncData.spotifyPlaying !== undefined) {
            setIsPlaying(syncData.spotifyPlaying);
          } else if (syncData.playing === false || syncData.queueEmpty) {
            setIsPlaying(false);
          }
        }
        refreshSongs(code);
        if (needsApproval) fetchRequests(code);
        fetchGuestCount(code);
      } catch {
        // Network error during poll — ignore
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [view, activeRoom?.code, activeRoom?.requireApproval]);

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
      }),
    });
    if (res.ok) {
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
      setActiveRoom((prev) => (prev ? { ...prev, songs } : null));
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

  const handleRequest = async (requestId: string, action: "approve" | "reject") => {
    if (!activeRoom) return;
    await fetch(`/api/rooms/${activeRoom.code}/requests`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, action }),
    });
    fetchRequests(activeRoom.code);
  };

  const togglePlay = async () => {
    if (!activeRoom) return;
    setPlayError("");
    const res = await fetch(`/api/rooms/${activeRoom.code}/play`, { method: "POST" });
    if (res.ok) {
      const data = await res.json();
      setIsPlaying(data.action === "playing" || data.action === "resumed");
    } else {
      const data = await res.json();
      setPlayError(data.error || "Open Spotify on a device and try again.");
      setTimeout(() => setPlayError(""), 6000);
    }
    refreshSongs(activeRoom.code);
  };

  const skipSong = async () => {
    if (!activeRoom) return;
    await fetch(`/api/rooms/${activeRoom.code}/skip`, { method: "POST" });
    refreshSongs(activeRoom.code);
  };

  const closeRoom = async () => {
    if (!activeRoom) return;
    const res = await fetch(`/api/rooms/${activeRoom.code}`, { method: "DELETE" });
    if (res.ok) {
      setActiveRoom(null);
      setView("rooms");
      fetchRooms();
    }
  };

  const lockSong = async (songId: string, position?: number) => {
    if (!activeRoom) return;
    await fetch(`/api/rooms/${activeRoom.code}/lock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ songId, position: position || 1 }),
    });
    refreshSongs(activeRoom.code);
  };

  const removeSong = async (songId: string) => {
    if (!activeRoom) return;
    await fetch(`/api/rooms/${activeRoom.code}/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ songId }),
    });
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
        setSearchStatus("Song added to queue!");
        refreshSongs(room.code);
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

  // Rooms list view
  if (view === "rooms") {
    return (
      <div className="min-h-dvh p-4 max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-8 pt-4">
          <div className="flex items-center gap-3">
            {user.image && (
              <img src={user.image} alt="" className="w-10 h-10 rounded-full" />
            )}
            <div>
              <p className="font-medium">{user.name}</p>
              <p className="text-text-secondary text-sm">Host Dashboard</p>
            </div>
          </div>
          <button
            onClick={() => {
              setView("create");
              fetchPlaylists();
            }}
            className="px-4 py-2 bg-accent hover:bg-accent-hover text-black font-semibold rounded-xl transition-colors"
          >
            + New Room
          </button>
        </div>

        {rooms.length === 0 ? (
          <div className="text-center py-20 text-text-secondary">
            <p className="text-lg mb-2">No rooms yet</p>
            <p className="text-sm">Create your first room to get started</p>
          </div>
        ) : (
          <div className="space-y-3">
            {rooms.map((room) => (
              <button
                key={room.id}
                onClick={() => room.isActive && manageRoom(room)}
                className={`w-full p-4 border rounded-xl text-left transition-colors ${
                  room.isActive
                    ? "bg-bg-card hover:bg-bg-card-hover border-border"
                    : "bg-bg-card/50 border-border/50 opacity-50 cursor-default"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{room.name}</p>
                    <p className="text-text-secondary text-sm">{room.playlistName}</p>
                  </div>
                  <div className="text-right">
                    <p className={`font-mono text-lg ${room.isActive ? "text-accent" : "text-text-secondary"}`}>{room.code}</p>
                    <p className={`text-xs ${room.isActive ? "text-upvote" : "text-downvote"}`}>
                      {room.isActive ? "Active" : "Closed"}
                    </p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Create room view
  if (view === "create") {
    return (
      <div className="min-h-dvh p-4 max-w-2xl mx-auto">
        <button
          onClick={() => setView("rooms")}
          className="text-text-secondary hover:text-white mb-6 mt-4 flex items-center gap-1 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>

        <h2 className="text-2xl font-bold mb-6">Create Room</h2>

        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-2">Room Name</label>
            <input
              type="text"
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
              placeholder="Friday Night Vibes"
              className="w-full px-4 py-3 bg-bg-card border border-border rounded-xl focus:outline-none focus:border-accent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-2">Select Playlist</label>
            {playlists.length === 0 ? (
              <p className="text-text-secondary text-sm">Loading playlists...</p>
            ) : (
              <div className="grid grid-cols-1 gap-2 max-h-64 overflow-y-auto pr-1">
                {playlists.map((pl) => (
                  <button
                    key={pl.id}
                    onClick={() => setSelectedPlaylist(pl)}
                    className={`flex items-center gap-3 p-3 rounded-xl border transition-colors text-left ${
                      selectedPlaylist?.id === pl.id
                        ? "border-accent bg-accent/10"
                        : "border-border bg-bg-card hover:bg-bg-card-hover"
                    }`}
                  >
                    {pl.images?.[0] && (
                      <img src={pl.images[0].url} alt="" className="w-12 h-12 rounded-lg" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate">{pl.name}</p>
                      <p className="text-text-secondary text-sm">{pl.tracks.total} tracks</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-2">
                Votes per User
              </label>
              <input
                type="number"
                min={1}
                max={50}
                value={votesPerUser}
                onChange={(e) => setVotesPerUser(Number(e.target.value))}
                className="w-full px-4 py-3 bg-bg-card border border-border rounded-xl focus:outline-none focus:border-accent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-2">
                Vote Reset (min)
              </label>
              <input
                type="number"
                min={5}
                max={1440}
                value={voteResetMinutes}
                onChange={(e) => setVoteResetMinutes(Number(e.target.value))}
                className="w-full px-4 py-3 bg-bg-card border border-border rounded-xl focus:outline-none focus:border-accent"
              />
            </div>
          </div>

          <div className="flex items-center justify-between p-4 bg-bg-card border border-border rounded-xl">
            <div>
              <p className="font-medium">Require Approval</p>
              <p className="text-text-secondary text-sm">Approve song requests before they&apos;re added</p>
            </div>
            <button
              onClick={() => setRequireApproval(!requireApproval)}
              className={`w-12 h-7 rounded-full transition-colors flex-shrink-0 flex items-center px-0.5 ${
                requireApproval ? "bg-accent" : "bg-border"
              }`}
            >
              <span
                className={`w-6 h-6 bg-white rounded-full transition-transform ${
                  requireApproval ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          </div>

          <button
            onClick={createRoom}
            disabled={!roomName.trim() || !selectedPlaylist || loading}
            className="w-full py-3.5 bg-accent hover:bg-accent-hover text-black font-semibold rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? "Creating..." : "Create Room"}
          </button>
        </div>
      </div>
    );
  }

  // Manage room view
  const nowPlaying = activeRoom?.songs?.find((s: any) => s.isPlaying);

  return (
    <div className="min-h-dvh p-4 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6 mt-4">
        <button
          onClick={() => {
            setView("rooms");
            setActiveRoom(null);
          }}
          className="text-text-secondary hover:text-white flex items-center gap-1 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to rooms
        </button>
      </div>

      {activeRoom && (
        <>
          {/* Room Header */}
          <div className="flex items-start justify-between mb-4">
            <div>
              <h2 className="text-2xl font-bold">{activeRoom.name}</h2>
              <p className="text-text-secondary text-sm">{activeRoom.playlistName}</p>
            </div>
            <div className="flex items-center gap-3">
              {guestCount > 0 && (
                <button
                  onClick={() => { setShowGuests(!showGuests); setShowQR(false); setShowSettings(false); setShowSearch(false); onSearchChange(""); if (!showGuests) fetchGuestDetails(); }}
                  className={`flex items-center gap-1.5 text-sm px-2 py-1 rounded-lg transition-colors ${
                    showGuests ? "text-accent bg-accent/15" : "text-text-secondary hover:text-white"
                  }`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  {guestCount}
                </button>
              )}
              <button
                onClick={() => { setShowQR(!showQR); setShowSettings(false); setShowGuests(false); setSelectedGuest(null); setShowSearch(false); onSearchChange(""); }}
                className={`bg-bg-card border rounded-lg px-3 py-1.5 transition-colors ${showQR ? "border-accent/50" : "border-border hover:border-accent/30"}`}
              >
                <p className="font-mono text-lg text-accent leading-none">{activeRoom.code}</p>
              </button>
            </div>
          </div>

          <div className="lg:grid lg:grid-cols-[1fr_1.5fr] lg:gap-6">
          {/* Left column: Now Playing, Controls, Panels */}
          <div>

          {/* Now Playing + Playback Controls — unified card */}
          <div className="mb-4 bg-bg-card border border-border rounded-xl overflow-hidden">
            {nowPlaying ? (
              <div className="p-4 flex items-center gap-4 border-b border-border">
                {nowPlaying.albumArt && (
                  <img src={nowPlaying.albumArt} alt="" className="w-14 h-14 rounded-lg shadow-md" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] text-accent font-semibold uppercase tracking-widest">Now Playing</p>
                  <p className="font-semibold truncate mt-0.5">{nowPlaying.trackName}</p>
                  <p className="text-text-secondary text-sm truncate">{nowPlaying.artistName}</p>
                </div>
              </div>
            ) : (
              <div className="p-4 border-b border-border text-center text-text-secondary text-sm">
                No song playing
              </div>
            )}
            {playError && (
              <div className="px-4 py-2 bg-downvote/10 text-sm text-center text-downvote">
                {playError}
              </div>
            )}
            <div className="flex">
              <button
                onClick={togglePlay}
                className="flex-1 py-3 text-center font-semibold transition-colors hover:bg-bg-card-hover border-r border-border flex items-center justify-center gap-2"
              >
                {isPlaying ? (
                  <>
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                      <rect x="6" y="4" width="4" height="16" rx="1" />
                      <rect x="14" y="4" width="4" height="16" rx="1" />
                    </svg>
                    Pause
                  </>
                ) : (
                  <>
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                    Play
                  </>
                )}
              </button>
              <button
                onClick={skipSong}
                className="flex-1 py-3 text-center font-semibold transition-colors hover:bg-bg-card-hover flex items-center justify-center gap-2"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M5 4v16l10-8zm12 0v16h2V4z" />
                </svg>
                Skip
              </button>
            </div>
          </div>

          {/* Search bar + action buttons */}
          <div className="flex gap-2 mb-4">
            <div className="flex-1 relative">
              <svg className="w-4 h-4 text-text-secondary absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                onFocus={() => { setShowSearch(true); setShowQR(false); setShowSettings(false); setShowGuests(false); setSelectedGuest(null); }}
                placeholder="Search queue or add songs..."
                className="w-full pl-9 pr-9 py-2.5 bg-bg-card border border-border rounded-xl text-sm focus:outline-none focus:border-accent"
              />
              {searchQuery ? (
                <button
                  onClick={() => {
                    onSearchChange("");
                    setShowSearch(false);
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-secondary hover:text-white transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              ) : searching ? (
                <div className="absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary text-xs">...</div>
              ) : null}
            </div>
            <button
              onClick={() => { setShowQR(!showQR); setShowSettings(false); setShowGuests(false); setSelectedGuest(null); setShowSearch(false); onSearchChange(""); }}
              className={`p-2.5 rounded-xl transition-colors ${
                showQR ? "bg-accent/15 text-accent border border-accent/30" : "bg-bg-card hover:bg-bg-card-hover border border-border"
              }`}
              title="Share Room"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
              </svg>
            </button>
            <button
              onClick={() => { setShowSettings(!showSettings); setShowQR(false); setShowGuests(false); setSelectedGuest(null); setShowSearch(false); onSearchChange(""); }}
              className={`p-2.5 rounded-xl transition-colors ${
                showSettings ? "bg-accent/15 text-accent border border-accent/30" : "bg-bg-card hover:bg-bg-card-hover border border-border"
              }`}
              title="Settings"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          </div>

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
              <p className="font-mono text-2xl text-accent font-bold mt-1">{activeRoom.code}</p>
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
              <div className="pt-2 border-t border-border">
                <button
                  onClick={() => setConfirmClose(true)}
                  className="w-full py-2.5 text-downvote text-sm font-medium hover:bg-downvote/10 rounded-xl transition-colors"
                >
                  Close Room
                </button>
              </div>
            </div>
          )}

          {/* Search results — shown when search bar has content */}
          {showSearch && searchQuery.trim() && (
            <div className="mb-4 bg-bg-card border border-border rounded-xl overflow-hidden">
              {searchStatus && (
                <p className="text-accent text-xs py-2 text-center border-b border-border">{searchStatus}</p>
              )}
              <div className="max-h-80 overflow-y-auto divide-y divide-border">
                {/* Queue matches */}
                {(() => {
                  const q = searchQuery.trim().toLowerCase();
                  const queueSongs = activeRoom?.songs?.filter((s: any) => !s.isPlaying) || [];
                  const matches = q
                    ? queueSongs.filter(
                        (s: any) =>
                          s.trackName.toLowerCase().includes(q) ||
                          s.artistName.toLowerCase().includes(q)
                      )
                    : [];
                  if (matches.length === 0) return null;
                  return (
                    <>
                      <p className="text-text-secondary text-xs font-medium px-1 pt-1">In Queue</p>
                      {matches.map((song: any) => {
                        const queueIdx = queueSongs.findIndex((s: any) => s.id === song.id);
                        return (
                          <div
                            key={song.id}
                            className={`flex items-center gap-3 p-2.5 rounded-xl ${
                              song.isLocked ? "bg-yellow-500/5 border border-yellow-500/30" : "bg-bg-primary"
                            }`}
                          >
                            {song.albumArt && (
                              <img src={song.albumArt} alt="" className="w-10 h-10 rounded-lg" />
                            )}
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">{song.trackName}</p>
                              <p className="text-text-secondary text-xs truncate">
                                {song.artistName} &middot; #{queueIdx + 1} in queue
                              </p>
                            </div>
                            <div className="flex items-center gap-1 flex-shrink-0">
                              {/* Move to position */}
                              <select
                                className="bg-bg-card border border-border rounded-lg text-xs px-1.5 py-1 focus:outline-none focus:border-accent"
                                value=""
                                onChange={(e) => {
                                  const targetPos = Number(e.target.value);
                                  if (!targetPos || !activeRoom) return;
                                  // Build new order with this song moved to targetPos
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
                                }}
                              >
                                <option value="">Move to...</option>
                                {queueSongs.map((_: any, idx: number) => (
                                  <option key={idx} value={idx + 1}>#{idx + 1}</option>
                                ))}
                              </select>
                              {/* Lock toggle */}
                              <button
                                onClick={() => lockSong(song.id)}
                                className={`p-1.5 rounded-lg text-xs transition-colors ${
                                  song.isLocked
                                    ? "bg-yellow-500/20 text-yellow-500"
                                    : "bg-bg-card-hover text-text-secondary hover:text-white"
                                }`}
                                title={song.isLocked ? "Unlock" : "Lock"}
                              >
                                {song.isLocked ? "\u{1F513}" : "\u{1F512}"}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </>
                  );
                })()}

                {/* Spotify results for adding */}
                {searchResults.length > 0 && (
                  <>
                    <p className="text-text-secondary text-xs font-medium px-1 pt-2">Add from Spotify</p>
                    {searchResults.map((track: any) => {
                      const inQueue = track.inQueue;
                      return (
                        <button
                          key={track.spotifyUri}
                          onClick={() => !inQueue && addSongToQueue(track)}
                          disabled={!!inQueue}
                          className={`w-full flex items-center gap-3 p-2.5 rounded-xl text-left transition-colors ${
                            inQueue
                              ? "bg-bg-primary/50 opacity-50 cursor-default"
                              : "bg-bg-primary hover:bg-bg-card-hover"
                          }`}
                        >
                          {track.albumArt && (
                            <img src={track.albumArt} alt="" className="w-10 h-10 rounded-lg" />
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
                          <span className={`text-xs font-medium flex-shrink-0 ${inQueue ? "text-text-secondary" : "text-accent"}`}>
                            {inQueue ? "In queue" : "+ Add"}
                          </span>
                        </button>
                      );
                    })}
                  </>
                )}
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
                    {req.albumArt && (
                      <img src={req.albumArt} alt="" className="w-10 h-10 rounded-lg" />
                    )}
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
          <h3 className="text-lg font-semibold mb-3">Queue</h3>
          <div ref={dragIdx === null ? songListRef : undefined} className="space-y-2 pb-8">
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
                  className={`flex items-center gap-3 p-3 bg-bg-card border rounded-xl song-card transition-all ${
                    song.isLocked
                      ? "border-yellow-500/50 bg-yellow-500/5"
                      : "border-border"
                  } ${dragIdx !== null && overIdx === i ? "ring-2 ring-accent/40" : ""}`}
                >
                  {/* Drag handle */}
                  <div
                    className="cursor-grab active:cursor-grabbing touch-none select-none p-1 -ml-1"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      // Measure the parent card element (the song row), not the small handle
                      const card = e.currentTarget.parentElement as HTMLElement;
                      const rect = card?.getBoundingClientRect();
                      dragItemHeight.current = rect?.height ?? 64;
                      dragStartY.current = e.clientY;
                      dragSongs.current = [...queueSongs];
                      setDragIdx(i);
                      setOverIdx(i);

                      // Auto-scroll when dragging near edges
                      let scrollRAF = 0;
                      let lastPointerY = e.clientY;
                      const EDGE_ZONE = 80; // px from top/bottom to trigger scroll
                      const SCROLL_SPEED = 8; // px per frame

                      const autoScroll = () => {
                        const vh = window.innerHeight;
                        if (lastPointerY < EDGE_ZONE) {
                          window.scrollBy(0, -SCROLL_SPEED);
                          // Adjust baseline so index tracks with scroll
                          dragStartY.current += SCROLL_SPEED;
                        } else if (lastPointerY > vh - EDGE_ZONE) {
                          window.scrollBy(0, SCROLL_SPEED);
                          dragStartY.current -= SCROLL_SPEED;
                        }
                        // Recalculate index during scroll
                        const delta = lastPointerY - dragStartY.current;
                        const off = Math.round(delta / (dragItemHeight.current + 8));
                        const newIdx = Math.max(0, Math.min(queueSongs.length - 1, i + off));
                        setOverIdx(newIdx);
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

                      const onUp = () => {
                        cancelAnimationFrame(scrollRAF);
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
                    <svg className="w-4 h-4 text-text-secondary" viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="9" cy="6" r="1.5" />
                      <circle cx="15" cy="6" r="1.5" />
                      <circle cx="9" cy="12" r="1.5" />
                      <circle cx="15" cy="12" r="1.5" />
                      <circle cx="9" cy="18" r="1.5" />
                      <circle cx="15" cy="18" r="1.5" />
                    </svg>
                  </div>

                  <span className="text-text-secondary text-sm w-5 text-center flex-shrink-0">
                    {song.isLocked ? (
                      <span className="text-yellow-500">{"\u{1F512}"}</span>
                    ) : (
                      i + 1
                    )}
                  </span>
                  {song.albumArt && (
                    <img src={song.albumArt} alt="" className="w-10 h-10 rounded-lg" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{song.trackName}</p>
                    <p className="text-text-secondary text-xs truncate">{song.artistName}</p>
                    {song.addedByName && (
                      <p className="text-accent text-xs truncate">Req&apos;d by {song.addedByName?.split(" ")[0] || song.addedByName}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="text-right mr-1">
                      <span className={`text-sm font-semibold ${song.upvotes - song.downvotes > 0 ? "text-upvote" : song.upvotes - song.downvotes < 0 ? "text-downvote" : "text-text-secondary"}`}>
                        {song.upvotes - song.downvotes > 0 ? "+" : ""}{song.upvotes - song.downvotes}
                      </span>
                      <p className="text-[10px] text-text-secondary">
                        <span className="text-upvote/70">{song.upvotes}&#x2191;</span>
                        {" "}
                        <span className="text-downvote/70">{song.downvotes}&#x2193;</span>
                      </p>
                    </div>
                    {/* Lock button */}
                    <button
                      onClick={() => lockSong(song.id)}
                      className={`p-1.5 rounded-lg text-xs font-medium transition-colors ${
                        song.isLocked
                          ? "bg-yellow-500/20 text-yellow-500 hover:bg-yellow-500/30"
                          : "bg-bg-card-hover text-text-secondary hover:text-white"
                      }`}
                      title={song.isLocked ? "Unlock" : "DJ Lock"}
                    >
                      {song.isLocked ? "\u{1F513}" : "\u{1F512}"}
                    </button>
                    {/* Remove button */}
                    <button
                      onClick={() => handleRemoveClick(song.id, song.trackName)}
                      className="p-1.5 rounded-lg text-text-secondary hover:text-downvote hover:bg-downvote/10 transition-colors"
                      title="Remove"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
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
                <p className="font-semibold text-center">Close this room?</p>
                <p className="text-text-secondary text-sm text-center">
                  This will end the session for all guests. This action cannot be undone.
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
                    Close Room
                  </button>
                </div>
              </div>
            </div>
          )}

          </div>
          </div>
        </>
      )}
    </div>
  );
}
