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

/**
 * Run a fade curve under a wall-clock budget.
 *
 * Each setVolume() call to Spotify takes ~100-300ms over the network, so a
 * naive `for (mult of multipliers) { await setVolume(); await sleep(stepMs); }`
 * overruns the declared duration by N × api_latency. For a 10s/20-step fade
 * with 200ms-avg latency, that's ~14s of actual fade — songs bleed past the
 * max-duration limit by 4s.
 *
 * This helper anchors each step to a wall-clock target (step i should complete
 * at (i+1) × stepMs from start), so any latency in setVolume() is absorbed by
 * shortening the next sleep instead of pushing the schedule later. If the
 * cumulative budget is exhausted before all steps run (slow network), we
 * break early — the caller's final `setVolume(0)` (or equivalent) still fires,
 * so the fade always reaches its endpoint within the declared duration.
 */
export async function runFadeStepsWithBudget(opts: {
  multipliers: number[];
  stepMs: number;
  budgetMs: number;
  applyVolume: (mult: number) => Promise<void>;
}): Promise<void> {
  const { multipliers, stepMs, budgetMs, applyVolume } = opts;
  const startTime = Date.now();
  for (let i = 0; i < multipliers.length; i++) {
    await applyVolume(multipliers[i]);
    const elapsed = Date.now() - startTime;
    if (elapsed >= budgetMs) break;
    const targetMs = (i + 1) * stepMs;
    const remaining = budgetMs - elapsed;
    const sleepFor = Math.min(remaining, Math.max(0, targetMs - elapsed));
    if (sleepFor > 0) {
      await new Promise((r) => setTimeout(r, sleepFor));
    }
  }
}
