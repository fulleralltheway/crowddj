import { describe, it, expect } from "vitest";
import { decideSyncStatus, PREQUEUE_LEAD_MS, AUTO_DURATION_MIN_SEC } from "./bluegrass-sync";

const baseSession = {
  id: "sess1",
  maxSongDurationSec: 120,
  fadeDurationSec: 3,
  isActive: true,
};

function playback(progress_ms: number, opts: Partial<{ is_playing: boolean; uri: string }> = {}) {
  return {
    is_playing: opts.is_playing ?? true,
    progress_ms,
    item: { uri: opts.uri ?? "spotify:track:abc", duration_ms: 180_000 },
  };
}

describe("decideSyncStatus", () => {
  it("reports session_ended when session is inactive", () => {
    const r = decideSyncStatus({ ...baseSession, isActive: false }, playback(60_000));
    expect(r.status).toBe("session_ended");
  });

  it("reports no_playback when Spotify returns null", () => {
    expect(decideSyncStatus(baseSession, null).status).toBe("no_playback");
  });

  it("reports no_playback when item is null", () => {
    const r = decideSyncStatus(baseSession, { is_playing: true, progress_ms: 0, item: null });
    expect(r.status).toBe("no_playback");
  });

  it("reports auto_disabled when maxSongDurationSec is below the floor", () => {
    const sess = { ...baseSession, maxSongDurationSec: AUTO_DURATION_MIN_SEC - 1 };
    const r = decideSyncStatus(sess, playback(60_000));
    expect(r.status).toBe("auto_disabled");
    expect(r.currentTrackUri).toBe("spotify:track:abc");
  });

  it("does NOT auto-disable at the spec's V7 scenario value (15s)", () => {
    // Spec V7 + V14 + V15 all run at maxSongDurationSec = 15. The floor must
    // permit this, otherwise the spec's own verification scenarios fail.
    // (Edge cases at 15s are covered by the adaptive-lead test below.)
    const sess = { ...baseSession, maxSongDurationSec: 15 };
    const r = decideSyncStatus(sess, playback(2_000));
    expect(r.status).toBe("playing"); // not auto_disabled
  });

  it("reports playing when progress is well below threshold", () => {
    const r = decideSyncStatus(baseSession, playback(10_000));
    expect(r.status).toBe("playing");
    expect(r.currentTrackUri).toBe("spotify:track:abc");
  });

  it("reports playing when paused, even if past threshold", () => {
    // Pause is intentional (announcement workflow). Don't fade.
    const r = decideSyncStatus(baseSession, playback(125_000, { is_playing: false }));
    expect(r.status).toBe("playing");
  });

  it("reports prequeued_maxdur inside the lead window with correct fadeInMs", () => {
    // maxMs = 120_000; lead = 15_000; threshold to enter pre-queue = 105_000
    const r = decideSyncStatus(baseSession, playback(110_000));
    expect(r.status).toBe("prequeued_maxdur");
    expect(r.fadeInMs).toBe(120_000 - 110_000);
    expect(r.fadeDurationMs).toBe(3_000);
    expect(r.currentTrackUri).toBe("spotify:track:abc");
  });

  it("reports prequeued_maxdur exactly at the lead boundary", () => {
    // baseSession maxSongDurationSec=120 → adaptive lead = min(15s, 40s) = 15s
    const r = decideSyncStatus(baseSession, playback(120_000 - PREQUEUE_LEAD_MS));
    expect(r.status).toBe("prequeued_maxdur");
    expect(r.fadeInMs).toBe(PREQUEUE_LEAD_MS);
  });

  it("uses an adaptive lead window for short thresholds", () => {
    // For maxSongDurationSec=15, lead = min(15000, 15000/3) = 5000ms
    // So 0-10s = playing, 10-15s = prequeued, >=15s = needs_fade
    const sess = { ...baseSession, maxSongDurationSec: 15 };
    expect(decideSyncStatus(sess, playback(5_000)).status).toBe("playing");
    expect(decideSyncStatus(sess, playback(11_000)).status).toBe("prequeued_maxdur");
    expect(decideSyncStatus(sess, playback(15_000)).status).toBe("needs_fade");
  });

  it("reports needs_fade when progress is past threshold", () => {
    const r = decideSyncStatus(baseSession, playback(125_000));
    expect(r.status).toBe("needs_fade");
    expect(r.fadeDurationMs).toBe(3_000);
  });

  it("reports needs_fade exactly at threshold", () => {
    const r = decideSyncStatus(baseSession, playback(120_000));
    expect(r.status).toBe("needs_fade");
  });

  it("clamps fadeDurationMs to a 500ms floor when fadeDurationSec is misconfigured to 0", () => {
    const sess = { ...baseSession, fadeDurationSec: 0 };
    const r = decideSyncStatus(sess, playback(125_000));
    expect(r.status).toBe("needs_fade");
    expect(r.fadeDurationMs).toBe(500);
  });
});
