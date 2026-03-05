"use client";

import { useState, useEffect, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";

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
  songs: any[];
};

type SongRequest = {
  id: string;
  trackName: string;
  artistName: string;
  albumArt: string | null;
};

export default function DashboardClient({ user }: { user: any }) {
  const [view, setView] = useState<"rooms" | "create" | "manage">("rooms");
  const [rooms, setRooms] = useState<Room[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [activeRoom, setActiveRoom] = useState<Room | null>(null);
  const [requests, setRequests] = useState<SongRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [playError, setPlayError] = useState("");

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
  }, [fetchRooms]);

  // Poll for song/request updates and auto-advance when managing a room
  useEffect(() => {
    if (view !== "manage" || !activeRoom) return;
    const interval = setInterval(() => {
      // Sync checks if the current song finished and auto-advances
      fetch(`/api/rooms/${activeRoom.code}/sync`, { method: "POST" });
      refreshSongs(activeRoom.code);
      if (activeRoom.requireApproval) fetchRequests(activeRoom.code);
    }, 5000);
    return () => clearInterval(interval);
  }, [view, activeRoom]);

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
    }
  };

  const refreshSongs = async (code: string) => {
    const res = await fetch(`/api/rooms/${code}/songs`);
    if (res.ok) {
      const songs = await res.json();
      setActiveRoom((prev) => (prev ? { ...prev, songs } : null));
    }
  };

  const fetchRequests = async (code: string) => {
    const res = await fetch(`/api/rooms/${code}/requests`);
    if (res.ok) setRequests(await res.json());
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

  const playRoom = async () => {
    if (!activeRoom) return;
    setPlayError("");
    const res = await fetch(`/api/rooms/${activeRoom.code}/play`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json();
      setPlayError(data.error || "Failed to start playback");
      setTimeout(() => setPlayError(""), 4000);
    }
    refreshSongs(activeRoom.code);
  };

  const skipSong = async () => {
    if (!activeRoom) return;
    await fetch(`/api/rooms/${activeRoom.code}/skip`, { method: "POST" });
    refreshSongs(activeRoom.code);
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
                onClick={() => manageRoom(room)}
                className="w-full p-4 bg-bg-card hover:bg-bg-card-hover border border-border rounded-xl text-left transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{room.name}</p>
                    <p className="text-text-secondary text-sm">{room.playlistName}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-accent text-lg">{room.code}</p>
                    <p className="text-text-secondary text-xs">
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
  return (
    <div className="min-h-dvh p-4 max-w-2xl mx-auto">
      <button
        onClick={() => {
          setView("rooms");
          setActiveRoom(null);
        }}
        className="text-text-secondary hover:text-white mb-6 mt-4 flex items-center gap-1 transition-colors"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to rooms
      </button>

      {activeRoom && (
        <>
          {/* Room Header */}
          <div className="flex items-start justify-between mb-6">
            <div>
              <h2 className="text-2xl font-bold">{activeRoom.name}</h2>
              <p className="text-text-secondary">{activeRoom.playlistName}</p>
            </div>
            <div className="text-right">
              <p className="font-mono text-2xl text-accent">{activeRoom.code}</p>
              <p className="text-text-secondary text-xs">Room Code</p>
            </div>
          </div>

          {/* QR Code */}
          <div className="bg-bg-card border border-border rounded-xl p-6 mb-6 flex flex-col items-center">
            <QRCodeSVG
              value={roomUrl}
              size={180}
              bgColor="transparent"
              fgColor="#ffffff"
              level="M"
            />
            <p className="text-text-secondary text-sm mt-3">Scan to join</p>
            <button
              onClick={() => navigator.clipboard.writeText(roomUrl)}
              className="mt-2 text-accent text-sm hover:text-accent-hover transition-colors"
            >
              Copy link
            </button>
          </div>

          {/* Admin Controls */}
          {playError && (
            <div className="mb-3 px-4 py-2.5 bg-downvote/10 border border-downvote/30 rounded-xl text-sm text-center text-downvote">
              {playError}
            </div>
          )}
          <div className="flex gap-2 mb-6">
            <button
              onClick={playRoom}
              className="flex-1 py-2.5 bg-accent hover:bg-accent-hover text-black font-semibold rounded-xl transition-colors"
            >
              ▶ Play
            </button>
            <button
              onClick={skipSong}
              className="flex-1 py-2.5 bg-bg-card hover:bg-bg-card-hover border border-border rounded-xl font-medium transition-colors"
            >
              Skip ⏭
            </button>
          </div>

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
                      <p className="font-medium truncate">{req.trackName}</p>
                      <p className="text-text-secondary text-sm truncate">{req.artistName}</p>
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
          <div className="space-y-2 pb-8">
            {activeRoom.songs?.map((song: any, i: number) => (
              <div
                key={song.id}
                className={`flex items-center gap-3 p-3 bg-bg-card border rounded-xl song-card ${
                  song.isPlaying
                    ? "border-accent now-playing"
                    : "border-border"
                }`}
              >
                <span className="text-text-secondary text-sm w-6 text-center">
                  {song.isPlaying ? (
                    <span className="text-accent text-lg">&#9654;</span>
                  ) : (
                    i + 1
                  )}
                </span>
                {song.albumArt && (
                  <img src={song.albumArt} alt="" className="w-10 h-10 rounded-lg" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{song.trackName}</p>
                  <p className="text-text-secondary text-sm truncate">{song.artistName}</p>
                </div>
                <div className="text-right text-sm">
                  <span className="text-upvote">+{song.upvotes}</span>
                  {" / "}
                  <span className="text-downvote">-{song.downvotes}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
