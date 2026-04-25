"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import { useAppHeight } from "@/lib/pwa";

type EventResponse = {
  room: {
    id: string;
    name: string;
    playlistName: string;
    playlistId: string;
    createdAt: string;
    closedAt: string | null;
  };
  stats: {
    durationMinutes: number;
    totalSongsPlayed: number;
    totalVotesCast: number;
    peakGuestCount: number;
    averageVotesPerSong: number;
    requestCount: number;
    requestApprovedCount: number;
    requestRejectedCount: number;
    requestPendingCount: number;
  };
  songsPlayed: Array<{
    id: string;
    spotifyUri: string;
    trackName: string;
    artistName: string;
    albumArt: string | null;
    durationMs: number;
    playedAt: string;
    upvotes: number;
    downvotes: number;
    netScore: number;
    order: number;
  }>;
  topVotedSongs: Array<{
    id: string;
    trackName: string;
    artistName: string;
    albumArt: string | null;
    upvotes: number;
    downvotes: number;
    netScore: number;
    rank: number;
  }>;
};

function formatDuration(min: number): string {
  if (min <= 0) return "—";
  if (min >= 60) return `${Math.floor(min / 60)}h ${min % 60}m`;
  return `${min}m`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function EventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  useAppHeight();

  const [data, setData] = useState<EventResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reopening, setReopening] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/events/${id}`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          if (res.status === 401) setError("Please sign in.");
          else if (res.status === 403) setError("You don't have access to this event.");
          else if (res.status === 404) setError("Event not found.");
          else if (res.status === 410) setError("Room is still active — close it first to view the event recap.");
          else setError(json?.error || "Failed to load event.");
          setData(null);
        } else {
          setData(json as EventResponse);
        }
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load event.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function handleReopen() {
    if (!data || reopening) return;
    setReopening(true);
    setReopenError(null);
    try {
      const res = await fetch("/api/rooms/reopen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRoomId: data.room.id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setReopenError(json?.error || "Failed to reopen room.");
        setReopening(false);
        return;
      }
      router.push("/dashboard");
    } catch {
      setReopenError("Failed to reopen room.");
      setReopening(false);
    }
  }

  if (loading) {
    return (
      <div
        className="flex items-center justify-center min-h-dvh"
        style={{ height: "var(--app-height, 100dvh)" }}
      >
        <div className="w-10 h-10 border-2 border-white/20 border-t-white rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div
        className="flex flex-col items-center justify-center min-h-dvh px-6 text-center"
        style={{ height: "var(--app-height, 100dvh)" }}
      >
        <p className="text-base font-medium text-white/80 mb-2">
          {error || "Something went wrong."}
        </p>
        <button
          onClick={() => router.push("/dashboard")}
          className="mt-4 px-5 py-2.5 bg-white/[0.08] hover:bg-white/[0.12] border border-white/[0.08] rounded-xl text-sm font-medium transition-colors"
        >
          Back to Dashboard
        </button>
      </div>
    );
  }

  const { room, stats, songsPlayed, topVotedSongs } = data;

  return (
    <div
      className="flex flex-col min-h-dvh max-w-2xl lg:max-w-3xl mx-auto overflow-hidden overscroll-none safe-top lg:min-h-0 lg:my-6 lg:bg-white/[0.03] lg:backdrop-blur-xl lg:border lg:border-white/[0.06] lg:rounded-3xl lg:shadow-[0_8px_32px_rgba(0,0,0,0.3)] lg:max-h-[calc(100dvh-3rem)]"
      style={{ height: "var(--app-height, 100dvh)" }}
    >
      {/* Sticky Header */}
      <div className="flex-shrink-0 bg-gradient-to-b from-bg-card/90 to-bg-primary/80 backdrop-blur-xl border-b border-white/[0.06] z-[60]">
        <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-3 lg:px-6">
          <button
            onClick={() => router.push("/dashboard")}
            aria-label="Back to dashboard"
            className="text-white/40 hover:text-white/70 flex items-center gap-1.5 transition-colors text-[13px] min-h-[44px] -my-2 py-2 -mx-1 px-1"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
            Back
          </button>
          <div className="flex-1 min-w-0 text-center">
            <h1 className="text-base lg:text-lg font-bold truncate">{room.name}</h1>
            <p className="text-[11px] lg:text-xs text-white/40 truncate">
              {formatDate(room.closedAt ?? room.createdAt)}
            </p>
          </div>
          <div className="w-12 flex-shrink-0" />
        </div>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto overscroll-none px-4 pt-5 pb-28 lg:px-6 lg:pb-32 space-y-6">
        <div>
          <p className="text-xs text-white/30 uppercase tracking-wider mb-1">
            Playlist
          </p>
          <p className="text-sm text-white/70 truncate">{room.playlistName}</p>
        </div>

        {/* Stats grid: 2x2 mobile, 4x1 lg */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Songs Played" value={stats.totalSongsPlayed} />
          <StatCard label="Total Votes" value={stats.totalVotesCast} />
          <StatCard label="Peak Guests" value={stats.peakGuestCount} />
          <StatCard label="Duration" value={formatDuration(stats.durationMinutes)} />
        </div>

        {stats.totalSongsPlayed > 0 && (
          <div className="text-[11px] text-white/40 -mt-2">
            Avg {stats.averageVotesPerSong} votes per song
          </div>
        )}

        {/* Top Voted */}
        {topVotedSongs.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-xs font-medium text-white/40 uppercase tracking-wider">
              Top Voted
            </h2>
            <ul className="space-y-2">
              {topVotedSongs.map((song) => (
                <li
                  key={song.id}
                  className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-3 py-2.5 flex items-center gap-3"
                >
                  <span className="w-6 text-center text-xs font-semibold text-white/40 tabular-nums flex-shrink-0">
                    {song.rank}
                  </span>
                  {song.albumArt ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={song.albumArt}
                      alt=""
                      className="w-10 h-10 rounded-md object-cover flex-shrink-0"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-md bg-white/[0.06] flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {song.trackName}
                    </p>
                    <p className="text-xs text-white/40 truncate">
                      {song.artistName}
                    </p>
                  </div>
                  <NetScoreChip score={song.netScore} />
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Songs Played */}
        {songsPlayed.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-xs font-medium text-white/40 uppercase tracking-wider">
              Songs Played ({songsPlayed.length})
            </h2>
            <ul className="space-y-2">
              {songsPlayed.map((song) => (
                <li
                  key={song.id}
                  className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-3 py-2.5 flex items-center gap-3"
                >
                  <span className="w-6 text-center text-xs font-semibold text-white/30 tabular-nums flex-shrink-0">
                    {song.order}
                  </span>
                  {song.albumArt ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={song.albumArt}
                      alt=""
                      className="w-10 h-10 rounded-md object-cover flex-shrink-0"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-md bg-white/[0.06] flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {song.trackName}
                    </p>
                    <p className="text-xs text-white/40 truncate">
                      {song.artistName}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
                    <span className="text-[11px] text-white/60 tabular-nums">
                      {song.upvotes > 0 || song.downvotes > 0
                        ? `+${song.upvotes} / -${song.downvotes}`
                        : "—"}
                    </span>
                    <span className="text-[10px] text-white/30 tabular-nums">
                      {formatTime(song.playedAt)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {songsPlayed.length === 0 && (
          <div className="text-center py-8 text-white/40 text-sm">
            No songs were played in this event.
          </div>
        )}

        {/* Requests footer */}
        {stats.requestCount > 0 && (
          <section className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3">
            <p className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2">
              Song Requests
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/50">
              <span>{stats.requestApprovedCount} approved</span>
              <span>{stats.requestRejectedCount} rejected</span>
              <span>{stats.requestPendingCount} pending</span>
              <span className="text-white/30">
                ({stats.requestCount} total)
              </span>
            </div>
          </section>
        )}

        {reopenError && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-sm text-red-300">
            {reopenError}
          </div>
        )}
      </div>

      {/* Sticky CTA footer */}
      <div className="flex-shrink-0 bg-gradient-to-t from-bg-primary via-bg-primary/95 to-transparent px-4 pt-4 pb-6 lg:px-6 lg:pb-6 safe-bottom">
        <button
          onClick={handleReopen}
          disabled={reopening}
          className="w-full min-h-[48px] py-3.5 bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-black font-semibold rounded-xl transition-colors lg:py-4 lg:text-base lg:rounded-2xl"
        >
          {reopening ? "Reopening…" : "Reopen as new room"}
        </button>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3 lg:py-4">
      <p className="text-xl lg:text-2xl font-bold tabular-nums">{value}</p>
      <p className="text-[11px] lg:text-xs text-white/40 mt-0.5">{label}</p>
    </div>
  );
}

function NetScoreChip({ score }: { score: number }) {
  const positive = score > 0;
  const negative = score < 0;
  const cls = positive
    ? "bg-accent/15 text-accent border-accent/20"
    : negative
      ? "bg-red-500/10 text-red-300 border-red-500/20"
      : "bg-white/[0.06] text-white/50 border-white/[0.08]";
  const sign = positive ? "+" : "";
  return (
    <span
      className={`text-[11px] font-semibold tabular-nums px-2 py-0.5 rounded-md border flex-shrink-0 ${cls}`}
    >
      {sign}
      {score}
    </span>
  );
}
