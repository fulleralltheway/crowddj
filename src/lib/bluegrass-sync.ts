/**
 * Pure threshold-detection logic for Bluegrass DJ sessions.
 *
 * Given a session row and the current Spotify playback, decide what the
 * sync layer should do — keep going, schedule a fade, fire a fade now, or
 * report no/external playback. Pure: no Spotify or DB calls. Tested in
 * `bluegrass-sync.test.ts`.
 *
 * Mirrors the PartyQueue `sync-rooms` cron's status discriminator so the
 * socket-server can process Bluegrass results with the same shape it uses
 * for rooms.
 */

export type BluegrassSessionShape = {
  id: string;
  maxSongDurationSec: number;
  fadeDurationSec: number;
  isActive: boolean;
  playlistUri?: string;
};

export type SpotifyPlaybackShape = {
  is_playing: boolean;
  progress_ms: number | null;
  item: {
    uri: string;
    duration_ms: number;
  } | null;
  context?: {
    uri: string;
    type?: string;
  } | null;
  device?: {
    id: string;
  } | null;
} | null;

export type SyncStatus =
  | "playing"
  | "no_playback"
  | "session_ended"
  | "prequeued_maxdur"
  | "needs_fade"
  | "auto_disabled"
  | "external_context";

export type SyncDecision = {
  status: SyncStatus;
  fadeInMs?: number;
  fadeDurationMs?: number;
  currentTrackUri?: string;
  deviceId?: string;
};

// How many ms before the threshold we surface `prequeued_maxdur` so the
// socket server can schedule a precise fade-start timer. Mirrors the
// 15-second pre-queue window used by sync-rooms.
export const PREQUEUE_LEAD_MS = 15_000;

// Auto-fade is only enabled when maxSongDurationSec >= this. Below this we
// treat it as "off". 10s is low enough to support short-class scenarios
// (and the spec's V7 test at 15s) while still rejecting truly accidental
// 1-2s values where the fade-out would dominate the playback window.
export const AUTO_DURATION_MIN_SEC = 10;

export function decideSyncStatus(
  sess: BluegrassSessionShape,
  playback: SpotifyPlaybackShape
): SyncDecision {
  if (!sess.isActive) {
    return { status: "session_ended" };
  }

  if (!playback || !playback.item || playback.progress_ms == null) {
    return { status: "no_playback" };
  }

  const currentTrackUri = playback.item.uri;
  const deviceId = playback.device?.id;

  // External-context detection: user manually started a different playlist
  // or album in Spotify (not via the DJ app). Don't fire threshold fades on
  // a context we don't own — that would yank them back to the bluegrass
  // playlist mid-track. Surface it so the UI can flag the divergence.
  // sess.playlistUri may be undefined in test fixtures; only check when set.
  if (
    sess.playlistUri &&
    playback.context?.uri &&
    playback.context.uri !== sess.playlistUri
  ) {
    return { status: "external_context", currentTrackUri, deviceId };
  }

  // Auto-fade disabled: just report what's playing so the socket can refresh
  // its TTL.
  if (sess.maxSongDurationSec < AUTO_DURATION_MIN_SEC) {
    return { status: "auto_disabled", currentTrackUri, deviceId };
  }

  // Treat paused playback as not-eligible-for-threshold-fade. The fade
  // would interrupt the user's announcement workflow (they paused on
  // purpose), and resume picks back up at the same progress_ms anyway.
  if (!playback.is_playing) {
    return { status: "playing", currentTrackUri, deviceId };
  }

  const maxMs = sess.maxSongDurationSec * 1000;
  const fadeMs = Math.max(500, sess.fadeDurationSec * 1000);
  // Adaptive pre-queue lead: when the threshold is short (e.g. 15s for the
  // spec's V7 test), the default 15s lead would open the pre-queue window
  // at 0ms — every position would be "prequeued_maxdur" and the socket
  // scheduler would re-fire on every tick. Cap the lead to a third of the
  // window so there's always some "playing" room before pre-queue starts.
  const lead = Math.min(PREQUEUE_LEAD_MS, Math.floor(maxMs / 3));
  const preQueueMs = Math.max(0, maxMs - lead);

  const progress = playback.progress_ms;

  if (progress >= maxMs) {
    return {
      status: "needs_fade",
      fadeDurationMs: fadeMs,
      currentTrackUri,
      deviceId,
    };
  }

  if (progress >= preQueueMs) {
    return {
      status: "prequeued_maxdur",
      fadeInMs: maxMs - progress,
      fadeDurationMs: fadeMs,
      currentTrackUri,
      deviceId,
    };
  }

  return { status: "playing", currentTrackUri, deviceId };
}
