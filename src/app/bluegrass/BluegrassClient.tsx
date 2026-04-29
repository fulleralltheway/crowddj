"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getSocket } from "@/lib/socket";
import { useAppHeight } from "@/lib/pwa";

// Single source of truth for socket connection state, satisfies the
// react-hooks/set-state-in-effect rule (no synchronous setState in effects).
function subscribeSocket(cb: () => void): () => void {
  const socket = getSocket();
  socket.on("connect", cb);
  socket.on("disconnect", cb);
  return () => {
    socket.off("connect", cb);
    socket.off("disconnect", cb);
  };
}
const getSocketConnected = () => getSocket().connected;
const getSocketConnectedServer = () => false;

type SessionRow = {
  id: string;
  playlistUri: string;
  playlistName: string;
  deviceId: string | null;
  maxSongDurationSec: number;
  fadeDurationSec: number;
  targetVolume: number;
  stopAfterCurrent: boolean;
  isActive: boolean;
};

type PlaybackState = {
  trackName: string | null;
  artistName?: string;
  albumArt?: string | null;
  durationMs?: number;
  positionMs?: number;
  isPlaying: boolean;
  deviceId?: string | null;
  deviceVolume?: number | null;
  trackUri?: string;
};

type Device = {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  volumePercent: number | null;
};

type Playlist = {
  id: string;
  uri: string;
  name: string;
  images: { url: string }[];
};

const FADE_FIRED_KEY = "bluegrass.lastFadeFiredAt";

export default function BluegrassClient({ initialSession }: { initialSession: SessionRow | null }) {
  useAppHeight();

  const [sess, setSess] = useState<SessionRow | null>(initialSession);
  const [playback, setPlayback] = useState<PlaybackState | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [picker, setPicker] = useState<"none" | "device" | "playlist" | "settings" | "ended">("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // useSyncExternalStore is the React-idiomatic way to mirror an external
  // singleton's state into a component without doing setState-in-effect.
  const socketConnected = useSyncExternalStore(subscribeSocket, getSocketConnected, getSocketConnectedServer);

  const sessRef = useRef<SessionRow | null>(initialSession);
  useEffect(() => { sessRef.current = sess; }, [sess]);

  // 1s state poll loop + client-polling threshold fallback (T11). Declared
  // before the socket effect so it's hoisted; the socket effect references it.
  const pollState = useCallback(async () => {
    const s = sessRef.current;
    if (!s) return;
    try {
      const res = await fetch(`/api/bluegrass/sessions/${s.id}/state`);
      if (!res.ok) return;
      const data: PlaybackState = await res.json();
      setPlayback(data);

      // Threshold fallback: only when socket isn't pushing precise schedules.
      if (
        !socketConnected &&
        data.isPlaying &&
        data.positionMs != null &&
        s.maxSongDurationSec >= 30
      ) {
        const maxMs = s.maxSongDurationSec * 1000;
        const fadeMs = Math.max(500, s.fadeDurationSec * 1000);
        const fireAtMs = maxMs - fadeMs;
        if (data.positionMs >= fireAtMs) {
          const last = parseInt(localStorage.getItem(FADE_FIRED_KEY) || "0", 10);
          // Idempotency: don't refire within fadeMs + 2s (transition is in flight).
          if (Date.now() - last > fadeMs + 2000) {
            localStorage.setItem(FADE_FIRED_KEY, String(Date.now()));
            const path = s.stopAfterCurrent ? "fade-pause" : "fade-skip";
            void fetch(`/api/bluegrass/sessions/${s.id}/${path}`, { method: "POST" });
          }
        }
      }
    } catch {}
  }, [socketConnected]);

  // Socket — join the session room, react to push events from the server.
  // Re-joins on reconnect so server-side activeSessions is restored.
  useEffect(() => {
    if (!sess) return;
    const socket = getSocket();
    const onConnect = () => socket.emit("join-session", sess.id);
    const onSessionEnded = () => setPicker("ended");
    const onStateChanged = () => { void pollState(); };
    socket.on("connect", onConnect);
    socket.on("session-ended", onSessionEnded);
    socket.on("session-state-changed", onStateChanged);
    socket.emit("join-session", sess.id); // Initial — covers already-connected case
    return () => {
      socket.emit("leave-session", sess.id);
      socket.off("connect", onConnect);
      socket.off("session-ended", onSessionEnded);
      socket.off("session-state-changed", onStateChanged);
    };
  }, [sess?.id, pollState]);

  useEffect(() => {
    if (!sess) return;
    void pollState();
    const t = setInterval(pollState, 1000);
    return () => clearInterval(t);
  }, [sess?.id, pollState]);

  // Load devices when needed
  const loadDevices = useCallback(async () => {
    const s = sessRef.current;
    if (!s) return;
    const res = await fetch(`/api/bluegrass/sessions/${s.id}/devices`);
    if (res.ok) setDevices(await res.json());
  }, []);

  // Load playlists when picker opens
  const loadPlaylists = useCallback(async () => {
    const res = await fetch("/api/spotify/playlists");
    if (res.ok) {
      const items = await res.json();
      setPlaylists(items.map((p: { id: string; uri: string; name: string; images?: { url: string }[] }) => ({
        id: p.id,
        uri: p.uri,
        name: p.name,
        images: p.images ?? [],
      })));
    }
  }, []);

  // Actions
  const post = async (path: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `${res.status}`);
        return null;
      }
      return await res.json();
    } finally {
      setBusy(false);
    }
  };

  const patchSession = async (data: Partial<SessionRow>) => {
    const s = sessRef.current;
    if (!s) return;
    const res = await fetch(`/api/bluegrass/sessions/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) setSess(await res.json());
  };

  const startWithPlaylist = async (playlist: Playlist, deviceId: string) => {
    const created = await post("/api/bluegrass/sessions", {
      playlistUri: playlist.uri,
      playlistName: playlist.name,
      deviceId,
    });
    if (created?.id) {
      setSess(created);
      setPicker("none");
      // Now fire /play
      await post(`/api/bluegrass/sessions/${created.id}/play`);
    }
  };

  const handlePlayPause = async () => {
    if (!sess) return;
    if (playback?.isPlaying) {
      await post(`/api/bluegrass/sessions/${sess.id}/fade-pause`);
    } else {
      // First play of a new session: hit /play. Subsequent: fade-resume.
      const hasPlayed = !!playback?.trackName;
      await post(`/api/bluegrass/sessions/${sess.id}/${hasPlayed ? "fade-resume" : "play"}`);
    }
    void pollState();
  };

  const handleSkip = async () => {
    if (!sess) return;
    await post(`/api/bluegrass/sessions/${sess.id}/fade-skip`);
    void pollState();
  };

  const handleStop = async () => {
    if (!sess) return;
    await post(`/api/bluegrass/sessions/${sess.id}/fade-pause`);
    void pollState();
  };

  const endSession = async () => {
    if (!sess) return;
    if (!confirm("End this session? Spotify will pause and the app will release control.")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/bluegrass/sessions/${sess.id}`, { method: "DELETE" });
      if (res.ok) {
        try { getSocket().emit("session-ended", sess.id); } catch {}
        localStorage.removeItem(FADE_FIRED_KEY);
        setSess(null);
        setPlayback(null);
        setPicker("ended");
      }
    } finally {
      setBusy(false);
    }
  };

  const startNewSession = () => {
    setPicker("playlist");
    void loadDevices();
    void loadPlaylists();
  };

  // ===== Render =====
  // No session: playlist picker as the landing screen
  if (!sess) {
    return (
      <Shell>
        {picker === "ended" ? (
          <div className="text-center space-y-6 pt-12">
            <h1 className="text-2xl font-bold">Session ended</h1>
            <p className="text-text-secondary">See you next class. Spotify is yours again.</p>
            <button
              onClick={startNewSession}
              className="w-full py-4 bg-accent text-black font-semibold rounded-2xl"
            >
              Start a new session
            </button>
          </div>
        ) : (
          <PlaylistPicker
            playlists={playlists}
            devices={devices}
            onPick={startWithPlaylist}
            onLoad={() => { void loadDevices(); void loadPlaylists(); }}
            busy={busy}
            error={error}
          />
        )}
      </Shell>
    );
  }

  const selectedDevice = devices.find((d) => d.id === sess.deviceId);
  const positionSec = Math.floor((playback?.positionMs ?? 0) / 1000);
  const durationCap = sess.maxSongDurationSec || Math.floor((playback?.durationMs ?? 0) / 1000);

  return (
    <Shell>
      {/* Top: device pill */}
      <button
        onClick={() => { setPicker("device"); void loadDevices(); }}
        className="flex items-center justify-between gap-2 w-full px-4 py-3 bg-bg-card/50 border border-white/[0.06] rounded-2xl text-sm"
      >
        <span className="text-text-secondary">Device</span>
        <span className="font-medium truncate">{selectedDevice?.name ?? "Pick device →"}</span>
      </button>

      {/* Now playing */}
      <div className="flex flex-col items-center gap-4 mt-6">
        <div className="aspect-square w-full max-w-xs rounded-2xl bg-bg-card overflow-hidden flex items-center justify-center">
          {playback?.albumArt ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={playback.albumArt} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="text-text-secondary text-sm">No track</div>
          )}
        </div>
        <div className="text-center w-full">
          <div className="text-xl font-semibold truncate">{playback?.trackName ?? "—"}</div>
          <div className="text-text-secondary text-sm truncate">{playback?.artistName ?? sess.playlistName}</div>
          <div className="text-text-secondary text-xs mt-1">
            {fmt(positionSec)} / {fmt(durationCap)}
            {sess.maxSongDurationSec >= 30 && playback?.durationMs && playback.durationMs / 1000 > sess.maxSongDurationSec
              ? " (limit)"
              : ""}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="mt-6 space-y-4">
        <button
          onClick={handlePlayPause}
          disabled={busy}
          className="w-full py-5 bg-accent text-black font-semibold rounded-2xl text-lg disabled:opacity-50"
        >
          {playback?.isPlaying ? "Pause" : "Play"}
        </button>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={handleSkip}
            disabled={busy || !playback?.isPlaying}
            className="py-4 bg-bg-card border border-white/[0.06] rounded-2xl font-medium disabled:opacity-40"
          >
            Skip
          </button>
          <button
            onClick={handleStop}
            disabled={busy || !playback?.isPlaying}
            className="py-4 bg-bg-card border border-white/[0.06] rounded-2xl font-medium disabled:opacity-40"
          >
            Stop
          </button>
        </div>
        <label className="flex items-center justify-between gap-3 px-4 py-3 bg-bg-card/50 border border-white/[0.06] rounded-2xl">
          <span className="text-sm">Stop after this song</span>
          <input
            type="checkbox"
            checked={sess.stopAfterCurrent}
            onChange={(e) => void patchSession({ stopAfterCurrent: e.target.checked })}
            className="w-5 h-5 accent-accent"
          />
        </label>
      </div>

      {/* Playlist row */}
      <div className="mt-6 flex items-center justify-between gap-3 text-sm">
        <span className="text-text-secondary truncate">Playlist: {sess.playlistName}</span>
        <button
          onClick={() => { setPicker("playlist"); void loadPlaylists(); }}
          className="text-accent text-sm shrink-0"
        >
          Change
        </button>
      </div>

      {/* Settings + End Session */}
      <div className="mt-6 grid grid-cols-2 gap-3">
        <button
          onClick={() => setPicker("settings")}
          className="py-3 bg-bg-card border border-white/[0.06] rounded-2xl text-sm"
        >
          Settings
        </button>
        <button
          onClick={endSession}
          disabled={busy}
          className="py-3 bg-red-500/10 border border-red-500/20 text-red-400 rounded-2xl text-sm font-medium disabled:opacity-40"
        >
          End Session
        </button>
      </div>

      {error && (
        <div className="mt-4 px-4 py-3 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl text-sm">
          {error}
        </div>
      )}

      {/* Sheets */}
      {picker === "device" && (
        <Sheet onClose={() => setPicker("none")} title="Pick playback device">
          <DeviceList
            devices={devices}
            selected={sess.deviceId}
            onPick={(id) => { void patchSession({ deviceId: id }); setPicker("none"); }}
            onRefresh={loadDevices}
          />
        </Sheet>
      )}
      {picker === "playlist" && (
        <Sheet onClose={() => setPicker("none")} title="Pick playlist">
          <PlaylistList
            playlists={playlists}
            selected={sess.playlistUri}
            onPick={async (p) => {
              await patchSession({ playlistUri: p.uri, playlistName: p.name });
              await post(`/api/bluegrass/sessions/${sess.id}/play`);
              setPicker("none");
              void pollState();
            }}
            onLoad={loadPlaylists}
          />
        </Sheet>
      )}
      {picker === "settings" && (
        <Sheet onClose={() => setPicker("none")} title="Settings">
          <SettingsForm sess={sess} onChange={patchSession} />
        </Sheet>
      )}
    </Shell>
  );
}

// ===== Subcomponents =====

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="min-h-dvh bg-bg-base text-white px-4 select-none"
      style={{
        paddingTop: "max(env(safe-area-inset-top), 1rem)",
        paddingBottom: "max(env(safe-area-inset-bottom), 1rem)",
        minHeight: "var(--app-height, 100dvh)",
      }}
    >
      <div className="max-w-md mx-auto">{children}</div>
    </div>
  );
}

function fmt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function Sheet({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-bg-card border-t border-white/[0.06] rounded-t-3xl sm:rounded-3xl px-4 pt-4 pb-8 max-h-[80vh] overflow-y-auto"
        style={{ paddingBottom: "max(env(safe-area-inset-bottom), 2rem)" }}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="text-text-secondary text-sm">Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function DeviceList({
  devices,
  selected,
  onPick,
  onRefresh,
}: {
  devices: Device[];
  selected: string | null;
  onPick: (id: string) => void;
  onRefresh: () => void;
}) {
  if (devices.length === 0) {
    return (
      <div className="space-y-3 text-sm text-text-secondary">
        <p>No Spotify devices found. Open Spotify on the laptop and play any track briefly so it shows up.</p>
        <button onClick={onRefresh} className="w-full py-3 bg-bg-card border border-white/[0.06] rounded-xl">
          Refresh
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {devices.map((d) => (
        <button
          key={d.id}
          onClick={() => onPick(d.id)}
          className={`w-full text-left px-4 py-3 rounded-xl border ${selected === d.id ? "border-accent bg-accent/10" : "border-white/[0.06] bg-bg-card/50"}`}
        >
          <div className="font-medium">{d.name}</div>
          <div className="text-text-secondary text-xs">{d.type}{d.isActive ? " · active" : ""}</div>
        </button>
      ))}
      <button onClick={onRefresh} className="w-full mt-2 py-2 text-sm text-accent">Refresh</button>
    </div>
  );
}

function PlaylistPicker({
  playlists,
  devices,
  onPick,
  onLoad,
  busy,
  error,
}: {
  playlists: Playlist[];
  devices: Device[];
  onPick: (p: Playlist, deviceId: string) => void;
  onLoad: () => void;
  busy: boolean;
  error: string | null;
}) {
  // Track only explicit user picks; default falls out of devices when empty.
  const [explicitDeviceId, setExplicitDeviceId] = useState<string>("");
  const deviceId = explicitDeviceId || devices.find((d) => d.isActive)?.id || devices[0]?.id || "";
  useEffect(() => { onLoad(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  return (
    <div className="pt-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Bluegrass DJ</h1>
        <p className="text-text-secondary text-sm">Pick a device + playlist to start.</p>
      </div>

      <div>
        <div className="text-xs text-text-secondary uppercase tracking-wide mb-2">Device</div>
        {devices.length === 0 ? (
          <div className="text-sm text-text-secondary">
            Open Spotify on the laptop and play any track briefly, then{" "}
            <button onClick={onLoad} className="text-accent underline">refresh</button>.
          </div>
        ) : (
          <select
            value={deviceId}
            onChange={(e) => setExplicitDeviceId(e.target.value)}
            className="w-full px-4 py-3 bg-bg-card border border-white/[0.06] rounded-xl"
          >
            {devices.map((d) => (
              <option key={d.id} value={d.id}>{d.name} ({d.type})</option>
            ))}
          </select>
        )}
      </div>

      <div>
        <div className="text-xs text-text-secondary uppercase tracking-wide mb-2">Playlist</div>
        <div className="space-y-2">
          {playlists.map((p) => (
            <button
              key={p.id}
              onClick={() => onPick(p, deviceId)}
              disabled={busy || !deviceId}
              className="w-full flex items-center gap-3 text-left px-3 py-2 rounded-xl border border-white/[0.06] bg-bg-card/50 disabled:opacity-40"
            >
              {p.images?.[0]?.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.images[0].url} alt="" className="w-10 h-10 rounded" />
              ) : (
                <div className="w-10 h-10 rounded bg-white/[0.06]" />
              )}
              <span className="font-medium truncate">{p.name}</span>
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="px-4 py-3 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl text-sm">
          {error}
        </div>
      )}
    </div>
  );
}

function PlaylistList({
  playlists,
  selected,
  onPick,
  onLoad,
}: {
  playlists: Playlist[];
  selected: string;
  onPick: (p: Playlist) => void;
  onLoad: () => void;
}) {
  useEffect(() => { onLoad(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  return (
    <div className="space-y-2">
      {playlists.map((p) => (
        <button
          key={p.id}
          onClick={() => onPick(p)}
          className={`w-full flex items-center gap-3 text-left px-3 py-2 rounded-xl border ${selected === p.uri ? "border-accent bg-accent/10" : "border-white/[0.06] bg-bg-card/50"}`}
        >
          {p.images?.[0]?.url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.images[0].url} alt="" className="w-10 h-10 rounded" />
          ) : (
            <div className="w-10 h-10 rounded bg-white/[0.06]" />
          )}
          <span className="font-medium truncate">{p.name}</span>
        </button>
      ))}
    </div>
  );
}

function SettingsForm({ sess, onChange }: { sess: SessionRow; onChange: (data: Partial<SessionRow>) => void }) {
  const [maxSec, setMaxSec] = useState(sess.maxSongDurationSec);
  const [fadeSec, setFadeSec] = useState(sess.fadeDurationSec);
  const [vol, setVol] = useState(sess.targetVolume);

  const commit = (data: Partial<SessionRow>) => onChange(data);

  return (
    <div className="space-y-5">
      <Field label={`Max song duration: ${maxSec === 0 ? "off" : `${maxSec}s`}`}>
        <input
          type="range"
          min={0}
          max={300}
          step={5}
          value={maxSec}
          onChange={(e) => setMaxSec(Number(e.target.value))}
          onPointerUp={(e) => commit({ maxSongDurationSec: Number((e.target as HTMLInputElement).value) })}
          className="w-full accent-accent"
        />
        <div className="text-text-secondary text-xs mt-1">Below 10s = off (auto-fade disabled)</div>
      </Field>

      <Field label={`Fade duration: ${fadeSec}s`}>
        <input
          type="range"
          min={1}
          max={10}
          step={1}
          value={fadeSec}
          onChange={(e) => setFadeSec(Number(e.target.value))}
          onPointerUp={(e) => commit({ fadeDurationSec: Number((e.target as HTMLInputElement).value) })}
          className="w-full accent-accent"
        />
      </Field>

      <Field label={`Target volume: ${vol}%`}>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={vol}
          onChange={(e) => setVol(Number(e.target.value))}
          onPointerUp={(e) => commit({ targetVolume: Number((e.target as HTMLInputElement).value) })}
          className="w-full accent-accent"
        />
      </Field>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-sm font-medium mb-2">{label}</div>
      {children}
    </div>
  );
}
