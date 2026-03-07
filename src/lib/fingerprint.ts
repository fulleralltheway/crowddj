"use client";

import FingerprintJS from "@fingerprintjs/fingerprintjs";

let cachedFingerprint: string | null = null;

function getFpCookie(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(/(?:^|; )crowddj_fp=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function setFpCookie(value: string) {
  if (typeof document === "undefined") return;
  const expires = new Date(Date.now() + 365 * 864e5).toUTCString();
  document.cookie = `crowddj_fp=${encodeURIComponent(value)};expires=${expires};path=/;SameSite=Lax`;
}

export async function getFingerprint(): Promise<string> {
  if (cachedFingerprint) return cachedFingerprint;

  // Check localStorage first, then cookie (persists across sessions and PWA↔browser)
  try {
    const stored = localStorage.getItem("crowddj_fp") || getFpCookie();
    if (stored) {
      cachedFingerprint = stored;
      // Ensure both storage layers have it
      localStorage.setItem("crowddj_fp", stored);
      setFpCookie(stored);
      return stored;
    }
  } catch {}

  const fp = await FingerprintJS.load();
  const result = await fp.get();
  cachedFingerprint = result.visitorId;
  try { localStorage.setItem("crowddj_fp", cachedFingerprint); } catch {}
  setFpCookie(cachedFingerprint);
  return cachedFingerprint;
}
