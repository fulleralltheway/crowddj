"use client";

import { useState, useEffect } from "react";

/** Detect if running as installed PWA */
export function useIsStandalone(): boolean {
  const [standalone, setStandalone] = useState(false);
  useEffect(() => {
    setStandalone(
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as any).standalone === true
    );
  }, []);
  return standalone;
}

/** Track online/offline status */
export function useNetworkStatus(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

/** Set --app-height CSS var — uses screen.height in standalone PWA to fill the real screen */
export function useAppHeight() {
  useEffect(() => {
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as any).standalone === true;
    const setHeight = () => {
      // In standalone PWA, window.innerHeight doesn't include the status bar area,
      // but the web view actually extends behind it. Use screen.height to fill fully.
      const h = isStandalone ? screen.height : window.innerHeight;
      document.documentElement.style.setProperty("--app-height", `${h}px`);
    };
    setHeight();
    window.addEventListener("resize", setHeight);
    window.addEventListener("orientationchange", setHeight);
    return () => {
      window.removeEventListener("resize", setHeight);
      window.removeEventListener("orientationchange", setHeight);
    };
  }, []);
}
