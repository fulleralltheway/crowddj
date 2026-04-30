"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { signOut } from "next-auth/react";
import { getSocket } from "@/lib/socket";
import { useAppHeight } from "@/lib/pwa";
import { AUTO_DURATION_MIN_SEC } from "@/lib/bluegrass-sync";

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
  tracksImported?: "pending" | "importing" | "imported" | "failed";
  isActive: boolean;
};

type QueueTrack = {
  id: string;
  spotifyUri: string;
  trackName: string;
  artistName: string;
  albumArt: string | null;
  durationMs: number;
  sortOrder: number;
  isPlaying: boolean;
  isPlayed: boolean;
  addedManually: boolean;
};

type SearchResult = {
  uri: string;
  name: string;
  artist: string;
  image: string | null;
  durationMs: number;
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

// Per-track idempotency record for the threshold-fallback fire. Storing the
// trackUri alongside the timestamp prevents a fade fired on track A from
// suppressing a legitimate fade on track B when Spotify auto-advances
// (track shorter than maxSongDurationSec) within the dedup window.
const FADE_FIRED_KEY = "bluegrass.lastFadeFired";
type FadeFiredRecord = { firedAt: number; trackUri: string };
function readFadeFired(): FadeFiredRecord | null {
  try {
    const raw = localStorage.getItem(FADE_FIRED_KEY);
    if (!raw) return null;
    if (raw.startsWith("{")) return JSON.parse(raw) as FadeFiredRecord;
    // Legacy plain-timestamp value from before the refactor — treat as a
    // null trackUri (will not match any current track, so won't suppress).
    return { firedAt: parseInt(raw, 10) || 0, trackUri: "" };
  } catch {
    return null;
  }
}
function writeFadeFired(trackUri: string) {
  try {
    const rec: FadeFiredRecord = { firedAt: Date.now(), trackUri };
    localStorage.setItem(FADE_FIRED_KEY, JSON.stringify(rec));
  } catch {}
}
// Persisted across reloads so a PWA reload mid-session (iOS PWA wakes,
// soft-refresh, etc.) doesn't trick handlePlayPause into firing /play
// (top-of-playlist) when it should be /fade-resume.
const STARTED_FOR_SESSION_KEY = "bluegrass.startedForSession";
const PLAYLIST_CACHE_KEY = "bluegrass.playlistCache";
const PLAYLIST_CACHE_TTL_MS = 60 * 60 * 1000; // 1h
// Spotify rate-limit cool-off. When we see a long Retry-After (>120s),
// stash the unlock time so subsequent picker opens skip the fetch
// entirely. Hitting the endpoint inside a long timeout can extend it.
const SPOTIFY_BLOCKED_UNTIL_KEY = "bluegrass.spotifyBlockedUntil";

function readBlockedUntil(): number {
  try {
    const raw = localStorage.getItem(SPOTIFY_BLOCKED_UNTIL_KEY);
    return raw ? parseInt(raw, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

function writeBlockedUntil(unlockAt: number) {
  try { localStorage.setItem(SPOTIFY_BLOCKED_UNTIL_KEY, String(unlockAt)); } catch {}
}

function clearBlockedUntil() {
  try { localStorage.removeItem(SPOTIFY_BLOCKED_UNTIL_KEY); } catch {}
}

type CachedPlaylists = { ts: number; items: Playlist[] };

function readCachedPlaylists(): Playlist[] | null {
  try {
    const raw = localStorage.getItem(PLAYLIST_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedPlaylists;
    if (Date.now() - parsed.ts > PLAYLIST_CACHE_TTL_MS) return null;
    return parsed.items;
  } catch {
    return null;
  }
}

function writeCachedPlaylists(items: Playlist[]) {
  try {
    localStorage.setItem(PLAYLIST_CACHE_KEY, JSON.stringify({ ts: Date.now(), items }));
  } catch {}
}

export default function BluegrassClient({ initialSession }: { initialSession: SessionRow | null }) {
  useAppHeight();

  const [sess, setSess] = useState<SessionRow | null>(initialSession);
  const [playback, setPlayback] = useState<PlaybackState | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [playlistsState, setPlaylistsState] = useState<"idle" | "loading" | "error">("idle");
  const [playlistsError, setPlaylistsError] = useState<string | null>(null);
  const [picker, setPicker] = useState<"none" | "device" | "playlist" | "settings" | "queue" | "ended">("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // useSyncExternalStore is the React-idiomatic way to mirror an external
  // singleton's state into a component without doing setState-in-effect.
  const socketConnected = useSyncExternalStore(subscribeSocket, getSocketConnected, getSocketConnectedServer);

  const sessRef = useRef<SessionRow | null>(initialSession);
  useEffect(() => { sessRef.current = sess; }, [sess]);

  // Wall-clock timestamp of the last user-initiated /play or /fade-resume
  // success. Used by the threshold fallback to suppress an immediate fire
  // when the user manually paused mid-song, made an announcement, then
  // resumed past the maxSongDuration mark.
  const lastResumeAtRef = useRef<number>(0);

  // Track which session id we've already fired /play for. Comparing this
  // against sess?.id lets handlePlayPause distinguish "first start" (calls
  // /play with explicit offset 0) from "resume after pause" (fade-resume).
  //
  // Persisted to localStorage so iOS PWA reload / wake-from-background /
  // soft-refresh doesn't reset us to "first start" and silently restart
  // the playlist from track 1 when the user hits Play.
  //
  // Lazy initializer (not a useEffect-based hydration) closes the 1-frame
  // tap-during-hydration window where handlePlayPause could see hasStarted
  // = false and fire /play before localStorage was read. The function only
  // runs on the client because BluegrassClient is a "use client" component
  // mounted under Next.js App Router; SSR sees the same null initial value
  // because initialSession is the prop that drives sess, not this state.
  // Hoisted above the socket effect so its setter is in TDZ-safe scope.
  const [startedForSession, setStartedForSession] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return localStorage.getItem(STARTED_FOR_SESSION_KEY);
    } catch {
      return null;
    }
  });
  // Mirror the state to localStorage whenever it changes. Decoupling the
  // persistence from the setter (vs wrapping setState in a useCallback)
  // keeps `setStartedForSession` as the stable useState setter, which
  // means it doesn't need to appear in any useEffect dep array.
  useEffect(() => {
    try {
      if (startedForSession) localStorage.setItem(STARTED_FOR_SESSION_KEY, startedForSession);
      else localStorage.removeItem(STARTED_FOR_SESSION_KEY);
    } catch {}
  }, [startedForSession]);

  // Refetch the session row from the server. The cron-driven fade-transition
  // path mutates server-side fields (e.g. clears stopAfterCurrent after it
  // pauses), but our local sess state doesn't see that without a refetch.
  // Declared before pollState so the threshold-fallback closure can call it.
  const refreshSession = useCallback(async () => {
    const s = sessRef.current;
    if (!s) return;
    const res = await fetch(`/api/bluegrass/sessions/${s.id}`);
    if (res.ok) setSess(await res.json());
  }, []);

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
      // Floor must match the lib's AUTO_DURATION_MIN_SEC so spec V14 (which
      // tests at maxSongDurationSec=15 with the socket down) actually fires.
      if (
        !socketConnected &&
        data.isPlaying &&
        data.positionMs != null &&
        s.maxSongDurationSec >= AUTO_DURATION_MIN_SEC
      ) {
        const maxMs = s.maxSongDurationSec * 1000;
        const fadeMs = Math.max(500, s.fadeDurationSec * 1000);
        const fireAtMs = maxMs - fadeMs;
        if (data.positionMs >= fireAtMs) {
          // Per-track idempotency: skip if we already fired on THIS trackUri
          // within the fade-in-flight window. Track-scoped so a fade on
          // track A doesn't suppress a legitimate fade on track B if
          // Spotify auto-advanced within the window.
          const last = readFadeFired();
          const sameTrackDedup =
            last &&
            last.trackUri === (data.trackUri ?? "") &&
            Date.now() - last.firedAt <= fadeMs + 2000;
          // Resume debounce: if user manually paused for an announcement
          // and resumes past the threshold, give them 5s of grace before
          // firing — otherwise the song rips out the moment they unpause.
          const justResumed =
            lastResumeAtRef.current > 0 &&
            Date.now() - lastResumeAtRef.current < 5000;
          if (!sameTrackDedup && !justResumed) {
            writeFadeFired(data.trackUri ?? "");
            // Single endpoint for both stopAfterCurrent and normal advance.
            // The server reads sess.stopAfterCurrent and runs the matching
            // branch in src/lib/bluegrass-fade.ts — identical to the
            // socket-driven cron path. Refresh the session row after so
            // local state mirrors the server-side stopAfterCurrent reset.
            void (async () => {
              try {
                const res = await fetch(`/api/bluegrass/sessions/${s.id}/fade-transition`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ expectedTrackUri: data.trackUri }),
                });
                // Server-side reason `session_inactive` means the session
                // was deleted under us (e.g. ended from another device).
                // Tear down local state so we stop polling a dead session.
                if (res.ok) {
                  const body = await res.json().catch(() => null);
                  if (body?.skipped && body?.reason === "session_inactive") {
                    setStartedForSession(null);
                    setSess(null);
                    setPicker("ended");
                    return;
                  }
                }
              } finally {
                void refreshSession();
              }
            })();
          }
        }
      }
    } catch {}
  }, [socketConnected, refreshSession]);

  // Socket — join the session room, react to push events from the server.
  // Re-joins on reconnect so server-side activeSessions is restored.
  useEffect(() => {
    if (!sess) return;
    const socket = getSocket();
    const onConnect = () => socket.emit("join-session", sess.id);
    const onSessionEnded = () => {
      // Mirror the local-side endSession() cleanup so an end fired from
      // another device clears persisted state too. Otherwise the next
      // session start could resurrect stale flags.
      try { localStorage.removeItem(FADE_FIRED_KEY); } catch {}
      setStartedForSession(null);
      setSess(null);
      setPlayback(null);
      setPicker("ended");
    };
    // session-state-changed fires on any server-driven transition. Refresh
    // both the playback poll AND the session row so flags like
    // stopAfterCurrent reflect the just-applied server-side update.
    const onStateChanged = () => { void pollState(); void refreshSession(); };
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
  }, [sess?.id, pollState, refreshSession]);

  useEffect(() => {
    if (!sess) return;
    void pollState();
    // 2s cadence (was 1s). Halves Spotify API pressure from foregrounded
    // sessions and the UI is still responsive — fade transitions are
    // already gated by the precise socket-scheduled timer, not the poll.
    const t = setInterval(pollState, 2000);
    return () => clearInterval(t);
  }, [sess?.id, pollState]);

  // PWA wake / tab refocus resync. iOS suspends background JS and the
  // socket; when the user returns, the position read from the next poll
  // can be far past the threshold. Without this handler the threshold
  // fallback fires immediately at full volume on a track that has already
  // been replaced — or worse, fires on the freshly-loaded next track.
  //
  // Two safeguards on resume:
  //   1. Treat the resume itself like a manual play for the 5s debounce
  //      window (lastResumeAtRef). Suppresses an immediate threshold fire.
  //   2. Refresh state + session row immediately so we react on the
  //      latest server-side data instead of stale 30-min-old fields.
  useEffect(() => {
    if (!sess) return;
    if (typeof document === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      lastResumeAtRef.current = Date.now();
      void pollState();
      void refreshSession();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [sess?.id, pollState, refreshSession]);

  // Load devices. Falls back to the sessionless endpoint when no active
  // session exists yet (the playlist picker is shown BEFORE a session is
  // created — we can't use the session-scoped endpoint there).
  const loadDevices = useCallback(async () => {
    const s = sessRef.current;
    const url = s ? `/api/bluegrass/sessions/${s.id}/devices` : `/api/bluegrass/devices`;
    const res = await fetch(url);
    if (res.ok) setDevices(await res.json());
  }, []);

  // Load playlists when picker opens. Surfaces loading + error states so a
  // silent failure doesn't leave the user staring at a blank list. Filters
  // out null/empty entries (Spotify's /me/playlists occasionally returns
  // them for inaccessible playlists).
  // Auto-retry timer for 429 rate limits. Clears on unmount or new load.
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (retryTimerRef.current) clearTimeout(retryTimerRef.current); }, []);
  // Ref-pointer to the latest loadPlaylists so the rate-limit setTimeout
  // can invoke it without referencing a self-recursive const (which trips
  // react-hooks/immutability).
  const loadPlaylistsRef = useRef<(opts?: { skipCache?: boolean }) => Promise<void>>(() => Promise.resolve());

  const loadPlaylists = useCallback(async (opts: { skipCache?: boolean; force?: boolean } = {}) => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    // Cache-first.
    if (!opts.skipCache) {
      const cached = readCachedPlaylists();
      if (cached && cached.length > 0) {
        setPlaylists(cached);
        setPlaylistsState("idle");
      }
    }

    // Spotify rate-limit back-off. If we know we're still inside a long
    // timeout window, do NOT call the endpoint — that just extends the
    // penalty. Show the remaining wait and let the user manually force.
    const blockedUntil = readBlockedUntil();
    const nowMs = Date.now();
    if (!opts.force && blockedUntil > nowMs) {
      const cached = readCachedPlaylists();
      const remainSec = Math.ceil((blockedUntil - nowMs) / 1000);
      const mins = Math.ceil(remainSec / 60);
      if (cached && cached.length > 0) {
        setPlaylists(cached);
        setPlaylistsState("idle");
      } else {
        setPlaylistsError(
          `Spotify has the app in a timeout for ~${mins} more minute${mins === 1 ? "" : "s"}. Don't reload — extra calls extend the window. Tap "Try anyway" to force a fetch.`
        );
        setPlaylistsState("error");
      }
      return;
    }

    setPlaylistsState((s) => (s === "idle" ? "idle" : "loading"));
    setPlaylistsError(null);
    try {
      // /api/bluegrass/playlists distinguishes 429 / 401 / 403 / 5xx so we
      // can show the right message and handle the right retry cadence.
      const res = await fetch("/api/bluegrass/playlists");

      if (res.status === 429) {
        const data = (await res.json().catch(() => ({}))) as { retryAfterSec?: number };
        const wait = Math.max(1, data.retryAfterSec ?? 60);
        // Persist the unlock time so subsequent picker opens skip the
        // network call entirely. Critical for long timeouts because each
        // call inside the window can push it out further.
        writeBlockedUntil(Date.now() + wait * 1000);
        const cached = readCachedPlaylists();
        if (cached && cached.length > 0) {
          setPlaylists(cached);
          setPlaylistsState("idle");
        } else {
          // For long timeouts (e.g., Spotify's 600s app-throttle window)
          // do NOT auto-retry — repeated calls inside the window can extend
          // it. Show a human-readable wait and let the user retry manually.
          if (wait > 120) {
            const mins = Math.ceil(wait / 60);
            setPlaylistsError(
              `Spotify has the app in a ${mins}-minute timeout. Wait it out, then tap Try again. (Don't reload the page in the meantime — extra calls can extend the window.)`
            );
          } else {
            setPlaylistsError(`Spotify is rate-limiting. Retrying in ${wait}s…`);
          }
          setPlaylistsState("error");
        }
        // Only schedule auto-retry for short waits.
        if (wait <= 120) {
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            void loadPlaylistsRef.current({ skipCache: true });
          }, wait * 1000);
        }
        return;
      }

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          detail?: string;
          status?: number;
        };
        const message =
          data.detail ||
          (data.error === "TokenRevoked"
            ? "Spotify access expired. Sign out and sign back in."
            : data.error
            ? `${data.error}${data.status ? ` (Spotify ${data.status})` : ""}`
            : `HTTP ${res.status}`);
        setPlaylistsError(message);
        setPlaylistsState("error");
        return;
      }
      const items = (await res.json()) as Array<{ id?: string; uri?: string; name?: string; images?: { url: string }[] } | null>;
      const cleaned: Playlist[] = (items ?? [])
        .filter((p): p is { id: string; uri: string; name: string; images?: { url: string }[] } => !!p && !!p.id && !!p.uri && !!p.name)
        .map((p) => ({ id: p.id, uri: p.uri, name: p.name, images: p.images ?? [] }));
      setPlaylists(cleaned);
      setPlaylistsState("idle");
      writeCachedPlaylists(cleaned);
      // We're unblocked; clear any back-off marker.
      clearBlockedUntil();
    } catch (e) {
      setPlaylistsError(e instanceof Error ? e.message : "Network error");
      setPlaylistsState("error");
    }
  }, []);

  // Keep the ref pointer current so the rate-limit retry uses the latest
  // version of loadPlaylists.
  useEffect(() => { loadPlaylistsRef.current = loadPlaylists; }, [loadPlaylists]);

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

  // Returns true on success, false on error. Errors surface via setError so
  // the existing toast/banner picks them up — important now that PATCH
  // deviceId can fail with `device_unavailable` (target device asleep)
  // and the user needs to see "wake the device" guidance, not a silently-
  // closed sheet that leaves them on the old device with no feedback.
  const patchSession = async (data: Partial<SessionRow>): Promise<boolean> => {
    const s = sessRef.current;
    if (!s) return false;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/bluegrass/sessions/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.detail || body.error || `${res.status}`);
        return false;
      }
      setSess(await res.json());
      return true;
    } finally {
      setBusy(false);
    }
  };

  const hasStarted = sess?.id != null && startedForSession === sess.id;

  const startWithPlaylist = async (playlist: Playlist, deviceId: string) => {
    const created = await post("/api/bluegrass/sessions", {
      playlistUri: playlist.uri,
      playlistName: playlist.name,
      deviceId,
    });
    if (created?.id) {
      setSess(created);
      setPicker("none");
      // Queue UI is hidden in production right now (per Jonathan, 2026-04-29).
      // The /queue/import endpoint exists but isn't wired into session start —
      // re-add the fetch here when the queue UI is re-enabled.
    }
  };

  const handlePlayPause = async () => {
    if (!sess) return;
    if (playback?.isPlaying) {
      await post(`/api/bluegrass/sessions/${sess.id}/fade-pause`);
    } else if (!hasStarted) {
      // First play of this session: /play sets the playlist context with
      // offset 0 so we always start at track 1 of the chosen playlist
      // (regardless of whatever Spotify was doing before).
      const r = await post(`/api/bluegrass/sessions/${sess.id}/play`);
      if (r?.ok !== false) {
        setStartedForSession(sess.id);
        lastResumeAtRef.current = Date.now();
      }
    } else {
      // Mid-session: smoothly resume whatever's loaded.
      const r = await post(`/api/bluegrass/sessions/${sess.id}/fade-resume`);
      if (r?.ok !== false) lastResumeAtRef.current = Date.now();
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
        setStartedForSession(null);
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
            playlistsState={playlistsState}
            playlistsError={playlistsError}
            devices={devices}
            onPick={startWithPlaylist}
            onLoad={() => { void loadDevices(); void loadPlaylists(); }}
            onReloadPlaylists={() => void loadPlaylists({ force: true })}
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
            {sess.maxSongDurationSec >= AUTO_DURATION_MIN_SEC && playback?.durationMs && playback.durationMs / 1000 > sess.maxSongDurationSec
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
            onPick={async (id) => {
              const ok = await patchSession({ deviceId: id });
              // Only close the sheet on success — if the transfer failed
              // (e.g. device asleep) the error banner is now visible and the
              // user should still be able to pick a different device or
              // dismiss manually.
              if (ok) setPicker("none");
            }}
            onRefresh={loadDevices}
          />
        </Sheet>
      )}
      {picker === "playlist" && (
        <Sheet onClose={() => setPicker("none")} title="Change playlist">
          <PasteUrlPicker
            disabled={busy}
            onPick={async (p) => {
              await patchSession({ playlistUri: p.uri, playlistName: p.name });
              setStartedForSession(null); // /play needs to fire fresh for the new playlist
              await post(`/api/bluegrass/sessions/${sess.id}/play`);
              setStartedForSession(sess.id);
              setPicker("none");
              void pollState();
              // Queue UI hidden — re-import not fired. See startWithPlaylist
              // for the symmetrical comment.
            }}
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
  // Track touch movement on the backdrop so a fling-scroll inside the panel
  // that ends with the user's finger crossing into the backdrop region
  // doesn't fire the close handler. Without this, scrolling near the panel
  // edge can dismiss the sheet mid-gesture on iOS.
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const onBackdropPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const onBackdropPointerMove = (e: React.PointerEvent) => {
    const start = dragRef.current;
    if (!start) return;
    if (Math.abs(e.clientX - start.x) > 6 || Math.abs(e.clientY - start.y) > 6) {
      start.moved = true;
    }
  };
  const onBackdropClick = () => {
    if (dragRef.current?.moved) {
      dragRef.current = null;
      return;
    }
    dragRef.current = null;
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center"
      onPointerDown={onBackdropPointerDown}
      onPointerMove={onBackdropPointerMove}
      onClick={onBackdropClick}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        // overscroll-contain + -webkit-overflow-scrolling:touch are both
        // load-bearing on iOS PWA. Without them, a fling-scroll inside the
        // panel that hits the top or bottom boundary leaves iOS thinking
        // the scroll was "consumed" by an ancestor (html has overflow:
        // hidden, so the chain dies) and the inner panel locks until the
        // sheet is closed and reopened. Symptom: list visible, taps work,
        // pan gestures do nothing — the freeze Jonathan reported.
        className="w-full max-w-md bg-bg-card border-t border-white/[0.06] rounded-t-3xl sm:rounded-3xl px-4 pt-4 pb-8 max-h-[80vh] overflow-y-auto overscroll-contain"
        style={{
          paddingBottom: "max(env(safe-area-inset-bottom), 2rem)",
          WebkitOverflowScrolling: "touch",
        }}
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
  playlistsState,
  playlistsError,
  devices,
  onPick,
  onLoad,
  onReloadPlaylists,
  busy,
  error,
}: {
  playlists: Playlist[];
  playlistsState: "idle" | "loading" | "error";
  playlistsError: string | null;
  devices: Device[];
  onPick: (p: Playlist, deviceId: string) => void;
  onLoad: () => void;
  onReloadPlaylists: () => void;
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
        <h1 className="text-2xl font-bold">Party Player</h1>
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

      <PasteUrlPicker disabled={busy || !deviceId} onPick={(p) => onPick(p, deviceId)} />

      {/* Playlist browser — auto-loaded inline (was previously gated behind a
          <details> dropdown to defer the rate-limited /me/playlists call).
          The cache + back-off in loadPlaylists() makes this safe: 1h
          localStorage cache means subsequent picker opens skip the network
          entirely, and a long Spotify timeout still surfaces a "wait it out"
          banner instead of hammering the endpoint. If we ever do hit a
          regression, this whole block can be reverted in one commit and
          re-collapse the list under <details>. */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs text-text-secondary uppercase tracking-wide">Or pick from your playlists</div>
          <button onClick={onReloadPlaylists} className="text-xs text-accent">Refresh</button>
        </div>
        {playlistsState === "loading" && playlists.length === 0 && (
          <div className="text-sm text-text-secondary">Loading playlists…</div>
        )}
        {playlistsState === "error" && (
          <div className="text-sm text-red-400 space-y-2">
            <div>{playlistsError ?? "Couldn't load playlists."}</div>
            <div className="flex gap-3">
              <button onClick={onReloadPlaylists} className="text-accent underline">Try again</button>
              <button
                onClick={() => signOut({ callbackUrl: "/login?callbackUrl=/bluegrass" })}
                className="text-accent underline"
              >
                Sign out & back in
              </button>
            </div>
          </div>
        )}
        {playlistsState === "idle" && playlists.length === 0 && (
          <div className="text-sm text-text-secondary">
            No playlists loaded.{" "}
            <button onClick={onReloadPlaylists} className="text-accent underline">Refresh</button>
          </div>
        )}
        {playlists.length > 0 && (
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
        )}
      </div>

      {error && (
        <div className="px-4 py-3 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl text-sm">
          {error}
        </div>
      )}
    </div>
  );
}

// Extract a Spotify playlist ID from a URL or URI on the client. No Spotify
// API call — we don't need /v1/playlists/{id} to validate, since playback
// endpoints (/me/player/play) accept the URI directly. Skipping validation
// means we can pick a playlist even while playlist-metadata endpoints are
// rate-limited.
function extractPlaylistId(input: string): string | null {
  const trimmed = input.trim();
  const url = trimmed.match(/open\.spotify\.com\/playlist\/([A-Za-z0-9]+)/);
  if (url) return url[1];
  const uri = trimmed.match(/^spotify:playlist:([A-Za-z0-9]+)$/);
  if (uri) return uri[1];
  if (/^[A-Za-z0-9]{16,}$/.test(trimmed)) return trimmed;
  return null;
}

/**
 * Manual playlist URL paste with NO Spotify call. Extract the ID locally,
 * trust the URL, and create the session immediately. The user names the
 * playlist themselves (we can't look up the real name while
 * /v1/playlists/{id} is rate-limited).
 */
/**
 * Queue panel — shows the imported playlist tracks for the active session,
 * lets the user search Spotify and insert tracks at "Play next" or
 * "Add to end". The queue is the source of truth for fade-skip and the
 * cron-driven fade-transition (ADR 0002), so any insert/remove here
 * directly affects the next track that plays.
 */
function QueueSheet({
  sessionId,
  tracksImported,
  currentTrackUri,
  onSessionChanged,
}: {
  sessionId: string;
  tracksImported: "pending" | "importing" | "imported" | "failed";
  currentTrackUri: string | undefined;
  onSessionChanged: () => Promise<void> | void;
}) {
  const [queue, setQueue] = useState<QueueTrack[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const refreshQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/bluegrass/sessions/${sessionId}/queue`);
      if (!r.ok) {
        setError(`HTTP ${r.status}`);
        return;
      }
      const data = (await r.json()) as { queue: QueueTrack[] };
      setQueue(data.queue);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    // Initial fetch on mount. refreshQueue does an async setState which the
    // react-hooks lint flags — but "fetch on mount" is the intended use of
    // useEffect here. Defer to a microtask so the synchronous setLoading
    // call inside refreshQueue happens *after* this effect body returns.
    queueMicrotask(() => { void refreshQueue(); });
  }, [refreshQueue]);

  // Refresh queue when the imported status flips to "imported".
  useEffect(() => {
    if (tracksImported === "imported") {
      queueMicrotask(() => { void refreshQueue(); });
    }
  }, [tracksImported, refreshQueue]);

  const retryImport = async () => {
    setImportBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/bluegrass/sessions/${sessionId}/queue/import`, { method: "POST" });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        setError((data as { detail?: string }).detail ?? `Import failed (HTTP ${r.status})`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setImportBusy(false);
      void onSessionChanged();
      void refreshQueue();
    }
  };

  // Debounced search — fires 300ms after the last keystroke. The setState
  // calls inside the timeout callback are NOT synchronous-in-effect (they
  // run in a separate task), so they're fine. The early-return path used
  // to call setSearchResults([]) synchronously, which the lint rule
  // flagged; we now derive the visible results below instead.
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) return;
    const t = setTimeout(async () => {
      setSearchBusy(true);
      setSearchError(null);
      try {
        const r = await fetch(`/api/bluegrass/search?q=${encodeURIComponent(q)}`);
        const data = await r.json();
        if (!r.ok) {
          setSearchError(data?.detail ?? `HTTP ${r.status}`);
          setSearchResults([]);
        } else {
          setSearchResults(data.results ?? []);
        }
      } catch (e) {
        setSearchError(e instanceof Error ? e.message : "Network error");
      } finally {
        setSearchBusy(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  // Hide stale results when the user clears the input or types <2 chars.
  // Derived view, not state — keeps the lint rule happy.
  const visibleSearchResults = search.trim().length < 2 ? [] : searchResults;
  const visibleSearchError = search.trim().length < 2 ? null : searchError;

  const insertTrack = async (track: SearchResult, position: "next" | "end") => {
    const r = await fetch(`/api/bluegrass/sessions/${sessionId}/queue/insert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uri: track.uri,
        name: track.name,
        artist: track.artist,
        image: track.image,
        durationMs: track.durationMs,
        position,
      }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      const code = (data as { error?: string }).error;
      if (code === "already_queued") {
        setSearchError("Already in the queue.");
        return;
      }
      setSearchError((data as { detail?: string }).detail ?? `Insert failed (${r.status})`);
      return;
    }
    setSearch("");
    setSearchResults([]);
    setSearchError(null);
    void refreshQueue();
  };

  const removeTrack = async (trackId: string) => {
    const r = await fetch(`/api/bluegrass/sessions/${sessionId}/queue/${trackId}`, {
      method: "DELETE",
    });
    if (!r.ok) {
      setError(`Remove failed (${r.status})`);
      return;
    }
    void refreshQueue();
  };

  const upcomingTracks = queue.filter((t) => !t.isPlayed);

  return (
    <div className="space-y-4">
      {/* Search + insert */}
      <div>
        <input
          type="search"
          inputMode="search"
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="Search Spotify…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full px-3 py-2 bg-bg-card border border-white/[0.06] rounded-xl text-sm"
        />
        {searchBusy && <div className="text-xs text-text-secondary mt-1">Searching…</div>}
        {visibleSearchError && (
          <div className="mt-2 px-3 py-2 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl text-xs">
            {visibleSearchError}
          </div>
        )}
        {visibleSearchResults.length > 0 && (
          <div className="mt-2 space-y-2 max-h-64 overflow-y-auto">
            {visibleSearchResults.map((r) => (
              <div key={r.uri} className="flex items-center gap-3 px-2 py-2 bg-bg-card/50 border border-white/[0.06] rounded-xl">
                {r.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={r.image} alt="" className="w-10 h-10 rounded shrink-0" />
                ) : (
                  <div className="w-10 h-10 rounded bg-white/[0.06] shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{r.name}</div>
                  <div className="text-xs text-text-secondary truncate">{r.artist}</div>
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  <button
                    onClick={() => void insertTrack(r, "next")}
                    className="px-2 py-1 bg-accent/20 text-accent rounded text-xs"
                  >
                    Play next
                  </button>
                  <button
                    onClick={() => void insertTrack(r, "end")}
                    className="px-2 py-1 bg-bg-card border border-white/[0.06] rounded text-xs"
                  >
                    Add to end
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Queue list */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs text-text-secondary uppercase tracking-wide">
            Up next ({upcomingTracks.length})
          </div>
          <button onClick={() => void refreshQueue()} className="text-xs text-accent">Refresh</button>
        </div>

        {tracksImported === "pending" || tracksImported === "importing" ? (
          <div className="text-sm space-y-2">
            <div className="text-text-secondary">Loading queue…</div>
            {/* Retry is available even during loading because the initial
                import fetch may have failed at the network layer (in which
                case tracksImported never advances past "pending"). */}
            <button
              onClick={() => void retryImport()}
              disabled={importBusy}
              className="px-3 py-1 bg-bg-card border border-white/[0.06] rounded text-xs disabled:opacity-40"
            >
              {importBusy ? "…" : "Retry import"}
            </button>
          </div>
        ) : tracksImported === "failed" ? (
          <div className="text-sm space-y-2">
            <div className="text-red-400">Couldn&apos;t import the playlist (Spotify rate-limit or error).</div>
            <button
              onClick={() => void retryImport()}
              disabled={importBusy}
              className="px-3 py-1 bg-accent/20 text-accent rounded text-xs disabled:opacity-40"
            >
              {importBusy ? "Retrying…" : "Retry import"}
            </button>
          </div>
        ) : loading && queue.length === 0 ? (
          <div className="text-sm text-text-secondary">Loading queue…</div>
        ) : error ? (
          <div className="text-sm text-red-400">{error}</div>
        ) : upcomingTracks.length === 0 ? (
          <div className="text-sm text-text-secondary">Queue is empty. Search above to add a song.</div>
        ) : (
          <div className="space-y-2">
            {upcomingTracks.map((t) => {
              const isCurrent =
                currentTrackUri != null && t.spotifyUri === currentTrackUri;
              return (
                <div
                  key={t.id}
                  className={`flex items-center gap-3 px-2 py-2 rounded-xl border ${isCurrent ? "border-accent bg-accent/10" : "border-white/[0.06] bg-bg-card/50"}`}
                >
                  {t.albumArt ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={t.albumArt} alt="" className="w-10 h-10 rounded shrink-0" />
                  ) : (
                    <div className="w-10 h-10 rounded bg-white/[0.06] shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">
                      {isCurrent && <span className="text-accent text-xs mr-1">▶</span>}
                      {t.trackName}
                      {t.addedManually && <span className="text-xs text-accent ml-2">added</span>}
                    </div>
                    <div className="text-xs text-text-secondary truncate">{t.artistName}</div>
                  </div>
                  {!isCurrent && (
                    <button
                      onClick={() => void removeTrack(t.id)}
                      className="px-2 py-1 text-text-secondary text-xs shrink-0"
                      aria-label="Remove from queue"
                    >
                      ✕
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function PasteUrlPicker({
  disabled,
  onPick,
}: {
  disabled: boolean;
  onPick: (p: Playlist) => void;
}) {
  const [input, setInput] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  const id = extractPlaylistId(input);

  const submit = () => {
    setError(null);
    if (!id) {
      setError("That doesn't look like a Spotify playlist link.");
      return;
    }
    onPick({
      id,
      uri: `spotify:playlist:${id}`,
      name: label.trim() || "Custom playlist",
      images: [],
    });
    setInput("");
    setLabel("");
  };

  return (
    <div>
      <div className="text-xs text-text-secondary uppercase tracking-wide mb-2">Playlist (paste URL)</div>
      <input
        type="url"
        inputMode="url"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder="https://open.spotify.com/playlist/..."
        value={input}
        onChange={(e) => setInput(e.target.value)}
        className="w-full px-3 py-2 bg-bg-card border border-white/[0.06] rounded-xl text-sm"
      />
      <input
        type="text"
        placeholder="Label (optional, e.g. 'Tuesday class')"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && id) submit(); }}
        className="w-full mt-2 px-3 py-2 bg-bg-card border border-white/[0.06] rounded-xl text-sm"
      />
      <p className="text-text-secondary text-xs mt-2">
        In Spotify, tap the playlist&apos;s … menu → Share → Copy link.
      </p>

      {error && (
        <div className="mt-3 px-3 py-2 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl text-sm">
          {error}
        </div>
      )}

      <button
        onClick={submit}
        disabled={disabled || !id}
        className="mt-3 w-full py-3 bg-accent text-black font-semibold rounded-xl disabled:opacity-40"
      >
        {id ? `Use playlist ${id.slice(0, 8)}…` : "Paste a playlist URL above"}
      </button>
    </div>
  );
}

function PlaylistList({
  playlists,
  playlistsState,
  playlistsError,
  selected,
  onPick,
  onLoad,
}: {
  playlists: Playlist[];
  playlistsState: "idle" | "loading" | "error";
  playlistsError: string | null;
  selected: string;
  onPick: (p: Playlist) => void;
  onLoad: () => void;
}) {
  useEffect(() => { onLoad(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  if (playlistsState === "loading") {
    return <div className="text-sm text-text-secondary">Loading playlists…</div>;
  }
  if (playlistsState === "error") {
    return (
      <div className="text-sm text-red-400">
        {playlistsError ?? "Couldn't load playlists."}{" "}
        <button onClick={onLoad} className="text-accent underline">Try again</button>
      </div>
    );
  }
  if (playlists.length === 0) {
    return (
      <div className="text-sm text-text-secondary">
        No playlists found.{" "}
        <button onClick={onLoad} className="text-accent underline">Refresh</button>
      </div>
    );
  }

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
