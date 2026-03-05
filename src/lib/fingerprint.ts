"use client";

import FingerprintJS from "@fingerprintjs/fingerprintjs";

let cachedFingerprint: string | null = null;

export async function getFingerprint(): Promise<string> {
  if (cachedFingerprint) return cachedFingerprint;

  // Check sessionStorage first (prevents multiple tabs with different fingerprints)
  const stored = sessionStorage.getItem("crowddj_fp");
  if (stored) {
    cachedFingerprint = stored;
    return stored;
  }

  const fp = await FingerprintJS.load();
  const result = await fp.get();
  cachedFingerprint = result.visitorId;
  sessionStorage.setItem("crowddj_fp", cachedFingerprint);
  return cachedFingerprint;
}
