---
name: Bluegrass UX Polish (round 2)
slug: bluegrass-ux-polish
status: shipped
created: 2026-04-30
signed_off: 2026-04-30
shipped: 2026-04-30
---

# Bluegrass UX Polish (round 2)

> Re-organize and visually refine the `/bluegrass` operator panel based on real-world usage feedback — surface auto-fade controls, fix cramped sheet headers, give Change Playlist a real list-browser, fit a phone screen.

Source plan (the contract this spec materializes): `~/.claude/plans/dreamy-munching-charm.md` — approved via ExitPlanMode on 2026-04-30.

## 1. Outcomes

- [ ] **O1.** Header reads "Bluegrass Ballroom" (not "Bluegrass").
- [ ] **O2.** Device row + Playlist row stacked at the top of the active-session view, both with status info, both tappable to open their respective pickers.
- [ ] **O3.** Automation card includes an "Auto-fade" row showing current `Cap Xs · Fade Ys`; tapping opens a focused `Auto-fade` sheet with the two sliders.
- [ ] **O4.** Footer contains only `End Session`. The Settings button no longer exists.
- [ ] **O5.** Sheet headers have visible breathing room: `text-lg` title, `pt-6 pb-5 px-6`, hairline border ≥24px from content; drag-handle pill (4×40 rounded gray) centered above the title.
- [ ] **O6.** Change Playlist sheet shows a scrollable list of the operator's Spotify playlists with thumbnails + names, filterable by typed search, AND a collapsed "Or paste a URL" section.
- [ ] **O7.** On iPhone 14 (375×812), the Hero (album art + track + progress) + Transport row + Volume slider all fit above the fold without scrolling.
- [ ] **O8.** No business-logic changes: `handlePlayPause`, `handleSkip`, `handleStop`, `liveVolumePush`, `patchSession`, `pollState`, fade engine, socket handling, scheduled-stops mechanics all unchanged.

## 2. Scope Boundaries

### In Scope

- Active-session render block in `src/app/bluegrass/BluegrassClient.tsx` (lines ~749–965)
- `Sheet` component (line ~942) — header padding/spacing + drag-handle pill
- `SettingsForm` → `AutoFadeForm` rename (only contains max-duration + fade-duration)
- `picker` discriminated union — `"settings"` value → `"auto-fade"`
- Change Playlist sheet content — `PasteUrlPicker` replaced with new `PlaylistList` + collapsed paste URL
- New `PlaylistList` sub-component extracted from the landing-screen `PlaylistPicker` (lines ~1141–1261)
- Title text change: `"Bluegrass"` → `"Bluegrass Ballroom"`

### Explicitly Out of Scope

- Tablet (iPad) two-column layout — phone-fit is what this round addresses
- Queue management UI surfacing (`QueueSheet` stays unexposed)
- Any changes to playback logic, fade engine, socket handling, polling, Spotify integration, scheduled-stops mechanics, auth, or the no-session landing screen
- New automation features
- Color / typography token changes (v2 palette stays exactly as-is)
- Tests for pre-existing un-tested code paths

## 3. Constraints

- **Technical:** Next.js 16 App Router, React 19, Tailwind v4, Framer Motion 12.x, shadcn-style `Slider` / `Button` primitives, existing `cn()` and `motion.ts` helpers.
- **PWA / iOS:** `Shell` wrapper has load-bearing iOS scroll-chain behavior — must not be modified. `Sheet` panel keeps `overscroll-contain` + `WebkitOverflowScrolling: touch`.
- **Spotify auth:** `/bluegrass` requires Spotify OAuth. Phase 6 QA must be done by Jonathan in a real authed session.
- **Time:** No hard deadline.
- **Design:** Match v2 design tokens (blue `#0057e1`, amber `#f59e0b`, surface levels, separator). No new tokens.
- **Backward compat:** 73+ legacy `bg-accent` / `text-accent` usages keep rendering correctly via the alias layer.

## 4. Prior Decisions This Builds On

- Tag `v4-bluegrass-redesign` (`1d20a10`) — current production state, the layout this round refines.
- Tag `v2-bluegrass-rebrand` (`83cc861`) — blue + amber palette source.
- Memory: `reference_design_system_rollback_tags.md` — rollback procedure if this goes wrong.
- Memory: `feedback_ios_pwa_scroll_chain.md` — every scroll surface needs `overscroll-contain` + momentum.
- Sheet drag-detection-on-backdrop logic — must remain (anti-iOS-fling-close).
- The 4 existing sheets stay — only their content + chrome change.
- ADR 0001 / 0002 are accepted; this feature doesn't propose new ADRs (no architectural decisions).

## 5. High-Level Tasks

1. Refit the `Sheet` component (drag-handle pill, header padding, title size).
2. Refactor active-session header (title text + stacked device/playlist rows).
3. Restructure Automation card (add Auto-fade row, remove standalone Playlist card below).
4. Rename Settings → Auto-fade (`picker` rename, `SettingsForm` → `AutoFadeForm`, Footer drops Settings).
5. Build new Change Playlist sheet content (extract `PlaylistList`, search field, collapsed paste URL).
6. Tighten phone fit (album art `260px → 220px`, margin reductions to fit hero+transport+volume above fold).
7. Verify (`tsc --noEmit`, `npm run build` zero-warnings), Phase 5 cold-context review, Phase 6 Jonathan QA, Phase 7 ship.

## 6. Verification Criteria

- [ ] **V1.** Header `<h1>` text is the literal string `"Bluegrass Ballroom"` (grep test).
- [ ] **V2.** The `<header>` element contains exactly two stacked tappable rows (device + playlist), each with a status icon and `ChevronRight` affordance.
- [ ] **V3.** Tapping the playlist row sets `picker === "playlist"`; that sheet renders the playlist list (not just URL paste).
- [ ] **V4.** Automation card contains exactly three rows: stop-after toggle, auto-fade row, scheduled-stops row — in that order, with dividers between.
- [ ] **V5.** Footer contains exactly one element: `End Session`. No Settings button anywhere.
- [ ] **V6.** `picker` discriminated union has the value `"auto-fade"`, not `"settings"`. AnimatePresence block opens the Auto-fade sheet on that value.
- [ ] **V7.** Sheet header has computed style: `pt-6 pb-5`, title `text-lg`, drag-handle pill visible centered above title.
- [ ] **V8.** On iPhone 14 viewport (375×812), with page scrolled to top, all of: title, device row, playlist row, album art, track text, progress bar, transport buttons, volume slider — visible without scrolling.
- [ ] **V9.** `tsc --noEmit` passes with zero errors.
- [ ] **V10.** `npm run build` passes with zero warnings.
- [ ] **V11.** No new console errors on `/login` (only unauthed reachable route).
- [ ] **V12.** Re-running playback flows produces identical network calls to current production baseline (same endpoints, same payload shapes).

---

## Smell Test

- [x] Every outcome observable from outside the system? **Yes** — every O is grep-able, screenshot-able, or network-traffic-visible.
- [x] Could every verification criterion be falsified by a real test? **Yes** — V1–V12 all have specific failure conditions.
- [x] Is anything in "In Scope" vague? **No** — files and components named.
- [x] Constraints I'm assuming but didn't write down? **None** — iOS scroll chain, auth, palette frozen, all explicit.
- [x] Could a stranger build this from this spec alone? **Yes** — file paths, line numbers, existing functions all called out.
- [x] Anything in "Out of Scope" actually load-bearing? **No** — iPad layout, queue UI, business logic are all genuinely deferrable.
