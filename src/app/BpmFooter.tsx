"use client";
import { usePathname } from "next/navigation";

// GetSongBPM TOS requires a visible attribution link back to their service on a
// publicly reachable page. We render the footer only on the public landing
// (`/`) and the publicly reachable in-room queue (`/room/...`). Authenticated
// surfaces (dashboard, create-room, settings) hide it for cleaner UX.
export function BpmFooter() {
  const pathname = usePathname();
  if (!pathname) return null;
  const visible = pathname === "/" || pathname.startsWith("/room/");
  if (!visible) return null;
  return (
    <p className="fixed bottom-2 left-1/2 -translate-x-1/2 text-[10px] text-white/10 z-0">
      BPM data by <a href="https://getsongbpm.com" target="_blank" rel="noopener">GetSongBPM</a>
    </p>
  );
}
