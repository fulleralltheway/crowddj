import { describe, it, expect } from "vitest";
import { buildFadeCurve } from "./fade-curve";

describe("buildFadeCurve", () => {
  it("ends at zero volume", () => {
    const { multipliers } = buildFadeCurve(3000);
    expect(multipliers[multipliers.length - 1]).toBe(0);
  });

  it("monotonically decreases from near-1 toward 0", () => {
    const { multipliers } = buildFadeCurve(3000);
    for (let i = 1; i < multipliers.length; i++) {
      expect(multipliers[i]).toBeLessThanOrEqual(multipliers[i - 1]);
    }
  });

  it("uses 4 steps/sec for fades up to 3s", () => {
    const { multipliers, stepMs } = buildFadeCurve(3000);
    // 3s × 4 steps/sec = 12 steps
    expect(multipliers.length).toBe(12);
    expect(stepMs).toBe(250);
  });

  it("uses 2 steps/sec for fades over 3s", () => {
    const { multipliers, stepMs } = buildFadeCurve(5000);
    // 5s × 2 steps/sec = 10 steps
    expect(multipliers.length).toBe(10);
    expect(stepMs).toBe(500);
  });

  it("caps at 24 total steps regardless of duration (rate-limit safety)", () => {
    const { multipliers } = buildFadeCurve(60_000); // 60s fade — would be 120 steps un-capped
    expect(multipliers.length).toBe(24);
  });

  it("has at least 2 steps for very short fades", () => {
    const { multipliers } = buildFadeCurve(100);
    expect(multipliers.length).toBeGreaterThanOrEqual(2);
  });

  it("step durations sum approximately to total duration", () => {
    const totalMs = 3000;
    const { multipliers, stepMs } = buildFadeCurve(totalMs);
    const total = stepMs * multipliers.length;
    // Allow ±50ms rounding slack
    expect(total).toBeGreaterThanOrEqual(totalMs - 50);
    expect(total).toBeLessThanOrEqual(totalMs + 50);
  });

  it("ease-out curve — drops fast at start, tapers near silence", () => {
    // (1 - t)^1.8: largest derivative near t=0, smallest near t=1.
    // Audibly: punchy initial drop, gentle approach to silence — feels natural.
    const { multipliers } = buildFadeCurve(3000);
    const startDelta = multipliers[0] - multipliers[1];
    const endDelta = multipliers[multipliers.length - 3] - multipliers[multipliers.length - 2];
    expect(startDelta).toBeGreaterThan(endDelta);
  });
});
