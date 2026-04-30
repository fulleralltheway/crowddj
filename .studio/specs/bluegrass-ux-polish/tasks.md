# Tasks — bluegrass-ux-polish

Each task: implementation step + verification criterion.

Order matches the seven phase commits in the worktree.

---

## Task 1 — Sheet header polish

**Implementation:**
- In `Sheet` component (BluegrassClient.tsx ~942):
  - Header padding: `pt-5 pb-3 px-5` → `pt-6 pb-5 px-6`
  - Title size: `text-base font-semibold` → `text-lg font-semibold`
  - Add a centered drag-handle pill above the title: `<div className="mx-auto h-1 w-10 rounded-full bg-[color:var(--surface-4)] mb-3" />` inside the header
  - Increase margin between header and content: `mb-4` → `mb-6`
- Keep drag-detection-on-backdrop logic verbatim (anti-iOS-fling-close).
- Keep `overscroll-contain` + `WebkitOverflowScrolling: touch` verbatim.

**Verification:**
- [ ] V7: visually inspect — drag-handle pill centered above title, generous header padding, content not crammed.

---

## Task 2 — Header rewrite (title + stacked rows)

**Implementation:**
- `<h1>` text: `"Bluegrass"` → `"Bluegrass Ballroom"`
- Replace single device pill with two stacked rows:
  - **Device row:** existing pattern (status dot + name + chevron) — kept
  - **Playlist row** (new): same shape — `ListMusic` icon + playlist name + `ChevronRight`. Tap → `setPicker("playlist")` + `loadPlaylists()`.
- Remove the standalone Playlist card from below the Automation section (it moves to header).

**Verification:**
- [ ] V1: header contains literal string `"Bluegrass Ballroom"`.
- [ ] V2: header has two stacked tappable rows; each has status icon + chevron.

---

## Task 3 — Footer cleanup

**Implementation:**
- Remove the Settings `<Button>` from footer.
- End Session becomes the only footer element, centered.
- Layout: `<footer className="mt-8 mb-2 flex items-center justify-center"> <button>End Session</button> </footer>`

**Verification:**
- [ ] V5: footer contains exactly one `End Session` button.

---

## Task 4 — Auto-fade migration

**Implementation:**
- `picker` discriminated union: replace `"settings"` with `"auto-fade"`.
- `SettingsForm` renamed to `AutoFadeForm` (function definition + callsite).
- Sheet that opens on `picker === "auto-fade"` has title `"Auto-fade"`.
- Add an Auto-fade row inside the Automation card (between Stop-after toggle and Scheduled stops):
  ```
  <button onClick={() => setPicker("auto-fade")} ...>
    <Clock /> Auto-fade
    <span>Cap {sess.maxSongDurationSec}s · Fade {sess.fadeDurationSec}s</span>
    <ChevronRight />
  </button>
  ```
- Removed Settings button (Task 3) is the only Settings reference deleted; Auto-fade row replaces its functional role.

**Verification:**
- [ ] V6: `picker` has `"auto-fade"`, not `"settings"`. `<AnimatePresence>` block renders Auto-fade sheet on that value.
- [ ] V4: Automation card has 3 rows in order (stop-after toggle, auto-fade, scheduled stops) with dividers.

---

## Task 5 — Change Playlist sheet rebuild

**Implementation:**
- Extract `PlaylistList` component from `PlaylistPicker` (lines ~1141–1261). Pure list-rendering: takes `playlists`, `playlistsState`, `playlistsError`, `disabled`, `onPick`, `onReload` props.
- New Change Playlist sheet body:
  ```
  <div>
    <input search field />  // optional: filter playlists by name
    <PlaylistList ... />
    <details>
      <summary>Or paste a URL</summary>
      <PasteUrlPicker ... />
    </details>
  </div>
  ```
- The landing-screen `PlaylistPicker` now uses the same `PlaylistList` component (shared source of truth, no regression).
- Hook up `loadPlaylists`, `playlists`, `playlistsState`, `playlistsError` from main BluegrassClient state (already exist).

**Verification:**
- [ ] V3: tapping playlist row in header opens sheet showing scrollable playlist list (not just URL paste).
- [ ] Search input present at top of sheet.
- [ ] "Or paste a URL" `<details>` collapsed by default.
- [ ] Landing-screen `PlaylistPicker` still works identically (regression check).

---

## Task 6 — Phone-fit tightening

**Implementation:**
- Album art: `max-w-[260px]` → `max-w-[220px]`.
- Margin reductions to fit hero+transport+volume above iPhone 14 fold (~660px usable):
  - `mt-7` (between sections) → `mt-5` in 2-3 places
  - Header section already compact
- Verify total height of header + hero + transport + volume ≤ ~510px.

**Verification:**
- [ ] V8: at iPhone 14 viewport (375×812), Chrome DevTools or `mcp__claude-in-chrome` screenshot — title, device row, playlist row, album art, track text, progress bar, transport buttons, volume slider all visible without scrolling.

---

## Task 7 — Verify + ship

**Implementation:**
- Phase 4: `cd ~/spotifyapp && npx tsc --noEmit` (zero errors), `npm run build` (zero warnings).
- Phase 5: Spawn fresh `general-purpose` sub-agent with cold-context review brief; output to `.studio/reviews/bluegrass-ux-polish.md`.
- Phase 6: Jonathan QA in browser (Spotify auth required).
- Phase 7: Surgical commits per phase, push, deploy gate, tag `v5-bluegrass-ux-polish`.

**Verification:**
- [ ] V9: `tsc --noEmit` clean.
- [ ] V10: `npm run build` zero warnings.
- [ ] V11: `/login` 200, no console errors.
- [ ] V12: Network tab shows identical endpoints + payload shapes for all playback flows.
- [ ] Phase 5 review report says "ship", zero block issues.
