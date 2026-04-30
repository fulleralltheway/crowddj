# PartyQueue Design System — v1 Proposal

**Status:** DRAFT — awaiting Jonathan sign-off before implementation
**Inspiration:** Apple Music (extracted tokens) + Tidal (brand language) + Bluegrass Ballroom venue context
**Created:** 2026-04-30
**Goal:** Distinctive, premium, not cookie-cutter. Reads as *event night at a venue*, not "another music app."

---

## Source Extraction

### Apple Music — extracted live from `music.apple.com/us/new`

| Token | Value | Notes |
|---|---|---|
| `--keyColor` (brand) | `#fa586a` | Signature pink/red — Apple Music's defining accent |
| `--keyColor-pressed` | `#ff7183` | Lighter, hover state |
| Body bg | `#1f1f1f` | Sophisticated mid-charcoal — NOT pure black |
| Gray 6 (deepest) | `#1c1c1e` | Card surfaces |
| Gray 5 | `#2c2c2e` | Raised surfaces |
| Gray 4 | `#3a3a3c` | Borders/separators |
| Gray 3 | `#48484a` | Disabled states |
| Gray 2 | `#636366` | Tertiary text |
| Gray 1 | `#98989d` | Secondary text |
| Type stack | `-apple-system, "system-ui", "SF Pro"...` | iOS-native |
| Large title (emphasized) | `700 26px / 1.23` | Section headers |
| Title 1 | `22px` | Page titles |
| Body | `400 13px / 1.38` | Note: smaller than typical web (13px not 14-16px) |

### Tidal — brand language (commonly known, not live-extracted)

- Pure black `#000000` backgrounds (OLED-first)
- Bright cyan / electric blue accent (varies by era)
- Geometric sans-serif (Inter or custom)
- Sharp corners (low border radius)
- Large hi-res album artwork as primary content
- "Master quality" / hi-fi positioning → minimal chrome, max content

---

## Recommended System for PartyQueue

### Why these choices vs. just copying Apple Music

PartyQueue is **not a streaming app**. It's a *real-time song-voting party app for a specific venue.* The design should signal:
1. **Event night at a ballroom** (warmth, occasion, celebration) — not utility
2. **Active participation** (voting, queuing) — not passive listening
3. **Hosted experience** (Bluegrass Ballroom is the host) — not platform-neutral

So I'm proposing a **two-accent system** that no other music app runs:
- **Primary: champagne gold** — premium venue / occasion / hosting
- **Energy: warm coral** (Apple Music's pink, slightly tuned) — voting, hot tracks, action

### Color Tokens

```css
/* Surface layers (deepest → highest) */
--surface-0:   #0a0a0a;  /* PWA outer chrome, status bar zones */
--surface-1:   #141414;  /* Page background */
--surface-2:   #1c1c1e;  /* Cards (lifted from Apple Music gray-6) */
--surface-3:   #2c2c2e;  /* Raised cards / now-playing */
--surface-4:   #3a3a3c;  /* Borders, dividers */

/* Text */
--text-primary:    #ffffff;
--text-secondary:  #a8a8b0;  /* Slightly warmer than Apple's #98989d */
--text-tertiary:   #636366;
--text-disabled:   #48484a;

/* PRIMARY ACCENT — champagne gold */
--accent-gold:         #d4b366;  /* Warm muted gold, NOT yellow */
--accent-gold-hover:   #e2c47a;
--accent-gold-pressed: #b8954a;
--accent-gold-soft:    rgba(212, 179, 102, 0.12);  /* Backgrounds, glows */

/* ENERGY ACCENT — Apple Music pink, tuned warmer */
--accent-coral:         #fa586a;
--accent-coral-hover:   #ff7183;
--accent-coral-pressed: #d94556;
--accent-coral-soft:    rgba(250, 88, 106, 0.15);

/* Semantic (vote feedback, status) */
--upvote:    #fa586a;  /* Coral — heat, momentum */
--downvote:  #636366;  /* Gray — recede, not hostile red */
--success:   #32d74b;  /* Apple system green, kept */
--warning:   #ff9f0a;  /* Apple system orange */
```

**Why coral for upvotes (not green):** Spotify-green upvotes are the cookie-cutter default. Coral reads as "hot" / "trending" / "people are voting this up" with more emotional pull. Green also clashes with our gold primary.

### Typography

```css
/* Display face — modern serif with optical sizing — NO music app uses this */
--font-display: "Fraunces", "Playfair Display", Georgia, serif;
/* Body — clean geometric workhorse */
--font-body:    "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
/* Mono — for codes, queue numbers, timestamps */
--font-mono:    "JetBrains Mono", "SF Mono", ui-monospace, monospace;

/* Scale (mobile-first, clamps for desktop) */
--text-xs:   clamp(0.75rem, 0.7rem + 0.25vw, 0.8125rem);   /* 12-13 */
--text-sm:   clamp(0.875rem, 0.83rem + 0.22vw, 0.9375rem); /* 14-15 */
--text-base: clamp(1rem, 0.95rem + 0.25vw, 1.0625rem);     /* 16-17 */
--text-lg:   clamp(1.125rem, 1.05rem + 0.4vw, 1.25rem);    /* 18-20 */
--text-xl:   clamp(1.375rem, 1.25rem + 0.6vw, 1.625rem);   /* 22-26 */
--text-2xl:  clamp(1.75rem, 1.5rem + 1.25vw, 2.5rem);      /* 28-40 */
--text-3xl:  clamp(2.25rem, 1.75rem + 2.5vw, 3.75rem);     /* 36-60 */

/* Weights */
--weight-regular:  400;
--weight-medium:   500;
--weight-semibold: 600;
--weight-bold:     700;
```

**Why Fraunces for display:** It's a variable serif with optical sizing. At display sizes (now-playing track title, "Bluegrass Ballroom" header) it has personality and warmth — feels like a venue's signage, not a tech product. At body sizes it falls back to Inter so legibility never suffers. Bold, distinctive, and appropriate for a *ballroom*.

If you hate the serif, fallback is **Geist** (Vercel's font) or **Manrope** — both are distinctive geometric sans without being generic.

### Spacing (8px grid)

```css
--space-1:  4px;
--space-2:  8px;
--space-3:  12px;
--space-4:  16px;
--space-5:  20px;
--space-6:  24px;
--space-8:  32px;
--space-10: 40px;
--space-12: 48px;
--space-16: 64px;
```

### Radius

```css
--radius-sm:   6px;   /* Buttons, small chips */
--radius-md:   12px;  /* Cards */
--radius-lg:   18px;  /* Now-playing card, modals */
--radius-pill: 9999px; /* Vote buttons, tags */
```

**Note:** Apple Music uses ~10-14px on cards. Tidal uses ~4px (sharp). I'm landing in the middle — softer than Tidal, slightly more confident than Apple Music. Pill radius for vote actions because circular feedback feels good under thumb.

### Shadows / Elevation

```css
--shadow-sm:  0 1px 2px rgba(0,0,0,0.4);
--shadow-md:  0 4px 12px rgba(0,0,0,0.5);
--shadow-lg:  0 12px 32px rgba(0,0,0,0.6);
--shadow-glow-gold:  0 0 24px rgba(212, 179, 102, 0.3);
--shadow-glow-coral: 0 0 24px rgba(250, 88, 106, 0.35);
```

The colored glows are the move for now-playing cards and hot tracks — premium PWAs use them, generic ones don't.

### Motion (Framer Motion presets)

```ts
export const transitions = {
  // Snappy UI — buttons, taps
  snap:    { type: 'spring', stiffness: 600, damping: 30 },
  // Smooth surfaces — modals, sheets
  surface: { type: 'spring', stiffness: 280, damping: 30 },
  // Slow ambient — now-playing entrance, hero
  hero:    { type: 'spring', stiffness: 120, damping: 22 },
  // Linear easing for layout shifts
  layout:  { type: 'tween', duration: 0.35, ease: [0.4, 0, 0.2, 1] },
}
```

---

## What This Replaces

| Current PartyQueue | Proposed |
|---|---|
| Spotify green `#1db954` (cookie-cutter) | Champagne gold `#d4b366` (distinctive) |
| Generic system font stack | Fraunces (display) + Inter (body) |
| Pure `#0a0a0a` flat bg | Layered surface system (5 levels) |
| Custom buttons / cards / modals (ad-hoc) | shadcn/ui components themed with these tokens |
| CSS keyframe animations only | Framer Motion presets for consistency |
| No type scale | Fluid responsive scale via `clamp()` |
| Single accent | Two-accent system (gold = host, coral = energy) |

---

## Open questions for Jonathan

1. **Gold + coral two-accent** — yes, or pick one? (Single-accent is simpler; two-accent is more distinctive.)
2. **Fraunces serif for display** — yes, or stick with sans (Geist / Manrope)?
3. **Vote color = coral instead of green** — comfortable abandoning "green = up" convention?
4. **Surface hierarchy 5 levels** — overkill, or appropriate for premium feel?

Once approved, next step is shadcn init with these tokens baked into the theme config + Framer Motion presets exported from `lib/motion.ts`.
