/**
 * Volume curve generator for song fades.
 *
 * Returns a sequence of volume multipliers (1.0 → 0.0) plus the wall-clock
 * gap between steps. Curve is ease-out (power 1.8): perceptually smooth on a
 * Spotify volume slider.
 *
 * Step rate adapts to fade duration to stay under Spotify's setVolume rate
 * limit: 4 steps/sec for fades ≤3s, 2 steps/sec for longer fades, capped at
 * 24 total steps regardless of duration.
 */
export function buildFadeCurve(durationMs: number): { multipliers: number[]; stepMs: number } {
  const stepsPerSec = durationMs <= 3000 ? 4 : 2;
  const totalSteps = Math.max(2, Math.min(24, Math.round((durationMs / 1000) * stepsPerSec)));
  const stepMs = Math.round(durationMs / totalSteps);

  const multipliers: number[] = [];
  for (let i = 1; i <= totalSteps; i++) {
    const t = i / totalSteps;
    const vol = Math.pow(1 - t, 1.8);
    multipliers.push(Math.max(0, vol));
  }

  return { multipliers, stepMs };
}
