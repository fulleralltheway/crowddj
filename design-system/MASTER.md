# PartyQueue Design System v2 — Bluegrass Ballroom Rebrand

**Status:** SHIPPED
**Source:** Live extraction from `bluegrassballroom.app` (their own brand tokens)
**Replaces:** v1 (Apple Music gold/coral mock — see git history pre-`bluegrass-rebrand` branch)
**Scope:** Dark-only PWA, themed to match Bluegrass Ballroom's identity

---

## Brand tokens — extracted directly from bluegrassballroom.app

| Their token | Hex | Role |
|---|---|---|
| `--bb-blue-cta` | `#0057e1` | Primary call-to-action (the brand blue) |
| `--bb-periwinkle-dark` | `#6b87c7` | Secondary blue family |
| `--bb-periwinkle` | `#8ea7e2` | Soft accent / highlight |
| `--bb-periwinkle-light` | `#b8caf0` | Lightest blue |
| `--bb-amber` | `#f59e0b` | Warm energy accent |
| `--bb-black` | `#1a1a1a` | Page background (their actual bg) |
| `--bb-gray-dark` | `#9ca3af` | Muted/secondary text |
| `--bb-green` | `#22c55e` | Success |
| `--bb-amber` | `#f59e0b` | Warning |
| `--bb-red` | `#ef4444` | Error / destructive |
| `--bb-white` | `#ffffff` | Foreground |

---

## Palette decisions

### Primary = `#0057e1` (their CTA blue)
Used for: now-playing glow, "Add to Queue" button, primary actions, focus rings, host/venue identity.

### Energy accent = `#f59e0b` (their amber)
Used for: hot tracks, vote chips, "trending up" indicators.

**Why amber for energy:** Blue + amber are complementary on the color wheel — maximum visual contrast. Both already in their brand palette. Amber-on-dark has the warmth that "this song is hot" needs to communicate.

### Surface hierarchy
Tuned to match their brand `#1a1a1a` page bg (was `#141414` in v1).

```
--surface-0: #0a0a0a   (PWA outer chrome)
--surface-1: #1a1a1a   (page bg = bb-black)
--surface-2: #232327   (cards)
--surface-3: #2c2c30   (raised, borders)
--surface-4: #3a3a40   (input borders)
```

### Typography
**All Inter, no serif.** Bluegrass's brand uses Inter only — adding a serif (as v1 did with Fraunces) breaks brand consistency.

```
--font-sans:    Inter + system fallback
--font-display: Inter (same — hierarchy via weight/size, not face)
--font-mono:    JetBrains Mono (for codes, queue numbers, times)
```

Display hierarchy lives in **weight + size**, not face change:
- Display (40px): Inter 800
- H1 (26px): Inter 700
- H2 (18px): Inter 600
- Body (15px): Inter 400

### Glows
```
--shadow-glow-blue:       0 0 28px rgba(0, 87, 225, 0.45)
--shadow-glow-amber:      0 0 28px rgba(245, 158, 11, 0.4)
--shadow-glow-periwinkle: 0 0 32px rgba(142, 167, 226, 0.3)
```

### Periwinkle family (unused so far, available)
The `#8ea7e2` and family are softer brand-blue tones — useful for hover ghosts on dark, secondary highlights, decorative glows that read as Bluegrass without competing with primary. Reserved for future use.

---

## Backward compatibility

Old v1 token names (`--gold`, `--coral`, `--shadow-glow-gold`, `--shadow-glow-coral`) are aliased to the new tokens. Existing references in code keep working — they silently render in the new palette. Same for the 242 legacy `bg-accent` / `bg-upvote` etc. usages from pre-v1.

```
--gold      → --bb-blue
--coral     → --amber
--glow-gold → --glow-blue
--glow-coral→ --glow-amber
```

This lets the rebrand ship without touching any existing component code.

---

## Files changed in v2

- `src/app/globals.css` — token rewrite + alias layer
- `src/app/layout.tsx` — dropped Fraunces import + className
- `src/app/design-preview/page.tsx` — gallery copy + hardcoded coral rgba refs updated to amber
- `design-system/MASTER.md` — this doc

No existing component (`/bluegrass`, `/dashboard`, `/login`, `/room/[code]`, etc.) was touched. The brand swap is entirely token-level.

---

## Live verification

1. `/design-preview` (no auth): fresh showcase with the Bluegrass palette + component gallery
2. `/bluegrass`, `/dashboard`, etc. (auth required): existing screens silently rendered in the new palette via aliases

---

## Rollback

```bash
git revert <bluegrass-rebrand-merge-hash>
```

This atomically restores v1 (gold/coral/Fraunces) without touching anything else.
