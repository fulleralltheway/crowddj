"use client";

import { useEffect } from "react";

type HelpGuideProps = {
  variant: "host" | "guest";
  onClose: () => void;
};

export default function HelpGuide({ variant, onClose }: HelpGuideProps) {
  // Close on Escape key
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Sheet */}
      <div className="relative w-full max-w-md max-h-[85vh] bg-bg-card border border-white/[0.08] rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col animate-in slide-in-from-bottom duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-white/[0.06]">
          <h2 className="text-lg font-bold tracking-tight">How It Works</h2>
          <button
            onClick={onClose}
            className="p-2 -mr-1 rounded-lg text-white/60 hover:text-white hover:bg-white/10 active:bg-white/15 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="overflow-y-auto px-5 py-4 space-y-5 text-sm leading-relaxed">
          {variant === "host" ? <HostContent /> : <GuestContent />}
        </div>

        {/* Close button — always visible at bottom */}
        <div className="shrink-0 px-5 py-4 border-t border-white/[0.06]">
          <button
            onClick={onClose}
            className="w-full py-2.5 rounded-xl bg-white/10 text-white/80 font-medium text-sm active:bg-white/15 transition-colors"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-accent">{icon}</span>
        <h3 className="font-semibold text-white/90">{title}</h3>
      </div>
      <div className="text-white/55 space-y-1.5 pl-6">{children}</div>
    </div>
  );
}

function HostContent() {
  return (
    <>
      <Section
        icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z" /></svg>}
        title="Before You Start"
      >
        <p>Open <strong className="text-white/70">Spotify</strong> on your <strong className="text-white/70">desktop app</strong> or <strong className="text-white/70">web player</strong> and start playing something. PartyQueue controls your Spotify playback, so it needs an active session.</p>
        <p className="text-white/40 text-xs">Note: Spotify mobile app works too, but desktop or web player is more reliable.</p>
      </Section>

      <Section
        icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>}
        title="Create a Room"
      >
        <p>Pick one of your Spotify playlists to start a room. The playlist songs become your queue. Share the <strong className="text-white/70">room code</strong> or <strong className="text-white/70">QR code</strong> with your crowd.</p>
      </Section>

      <Section
        icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>}
        title="Guest Voting"
      >
        <p>Guests vote songs up or down from their phones. The queue automatically reorders by popularity so the crowd picks what plays next.</p>
      </Section>

      <Section
        icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>}
        title="DJ Controls"
      >
        <p><strong className="text-white/70">Lock songs</strong> at specific positions so votes can't move them.</p>
        <p><strong className="text-white/70">Skip / fade</strong> to the next song at any time.</p>
        <p><strong className="text-white/70">Song threshold</strong> sets how long each song plays before auto-transitioning with a fade-out.</p>
        <p><strong className="text-white/70">Drag to reorder</strong> the queue manually.</p>
      </Section>

      <Section
        icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>}
        title="Runs in the Background"
      >
        <p>You can close the dashboard and the queue keeps going. Songs auto-transition and votes keep coming in. Come back anytime to manage things.</p>
      </Section>

      <Section
        icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>}
        title="Built for Phones"
      >
        <p>Guests use PartyQueue on their phone browsers. They can add it to their home screen for a full-screen app experience.</p>
      </Section>
    </>
  );
}

function GuestContent() {
  return (
    <>
      <Section
        icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>}
        title="Vote on Songs"
      >
        <p>Tap the <strong className="text-white/70">up or down arrows</strong> next to any song. The more votes a song gets, the sooner it plays.</p>
      </Section>

      <Section
        icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>}
        title="Request Songs"
      >
        <p>Use the <strong className="text-white/70">search bar</strong> to find and request songs that aren't in the queue yet. The DJ may need to approve them first.</p>
      </Section>

      <Section
        icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>}
        title="Locked Songs"
      >
        <p>Songs marked <strong className="text-white/70">"Up Next"</strong> or with a lock are set by the DJ and can't be voted on.</p>
      </Section>

      <Section
        icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
        title="Good to Know"
      >
        <p>You have a limited number of votes that refresh periodically. Use them wisely!</p>
        <p>Add PartyQueue to your home screen for the best experience.</p>
      </Section>
    </>
  );
}
