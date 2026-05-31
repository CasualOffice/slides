# UX polish tracker — v0.1 → v0.2

Source: [docs/UX_AUDIT_v0.1.0.md](./UX_AUDIT_v0.1.0.md). One row per audit item, status flipped as work lands.

Status: `[ ]` todo · `[~]` in flight · `[x]` done · `[!]` blocked · `[-]` won't fix · `[c]` coordination required (parallel-lane file is currently dirty)

Last update: 2026-06-01 — tracker created.

---

## Showstoppers (must-fix before user testing)

| # | Item | Files | Effort | Status |
|---|---|---|---|---|
| S1 | Add `Format` / `Slide` / `Arrange` menus to menu strip | `TitleBar.tsx` (buildMenus + handleMenuItem) + `en.json` (new menu.format / menu.slide / menu.arrange namespaces) + `clearFormatting` import wired | 1–2 h | `[x]` |
| S2 | Surface Theme / Background / Layout as inline toolbar buttons | `Toolbar.tsx` — 3 new inline buttons (groupLayout / groupTheme / groupBackground) inserted between groupSlide and group6; reuse existing layoutAnchor / bgAnchor / `__casualSlides_openThemes` so no new state. Slide ▾ dropdown kept intact for habit-path users. | 30 min | `[x]` |
| S3 | Move `Present` action to status-bar (right of zoom) | `StatusBar.tsx` + `Toolbar.tsx:639–652` | 30 min | `[x]` statusbar side · `[c]` toolbar side |
| S4 | Default deck title `"Casual Slides — Spike A"` → `"Untitled presentation"` | `default-slide.ts:12` | 15 min | `[x]` |
| S5 | Add icons to every menu item | `TitleBar.tsx` (added `icon?` field to MenuItem + 18 px icon slot in render) | 1 h | `[x]` (cut + paste menu items have no icon — `content_cut` / `content_paste` aren't in the set; slot stays blank to preserve column alignment) |

## Polish (during v0.1 → v0.2 polish window)

| # | Item | Files | Effort | Status |
|---|---|---|---|---|
| P1 | Brand mark bump 28×36 → 32×40 | `TitleBar.tsx:292` | 5 min | `[x]` |
| P2 | De-emphasise "Saved" chip to inline whisper after filename | `TitleBar.tsx` (inline `fontSize: 12 / fontWeight: 400 / color: text-mute / marginLeft: 8` on the saved span) | 15 min | `[x]` |
| P3 | Hover action overlay on slide-rail thumbnails (Duplicate / Delete) | `SlideRail.tsx` (inline styles, parallel-lane styles.css can later hook the classes) + `en.json` | 30 min | `[x]` |
| P4 | De-saturate Slideshow CTA (ghost style, no fill) | `Toolbar.tsx:641` (`cs-btn--accent` → `cs-btn--ghost`) | 5 min | `[x]` |
| P5 | Format pane opacity slider — disabled-with-tooltip | `FormatPane.tsx` (new `OpacitySection` between Shadow and Arrange — collapsed by default, slider disabled at 100%, tooltip + hint explain the next-Univer-upgrade dependency) + `en.json` (`format.sections.opacity` + `format.opacity.{label,disabledTooltip,disabledHint}`) | 30 min | `[x]` (stub) |
| P6 | Page Setup: add 16:10, A4 portrait, A4 landscape, US Letter presets | `PageSetupDialog.tsx:30–32` | 15 min | `[x]` |
| P7 | Theme picker: modal → right-rail side panel with live preview | `ThemePicker.tsx:133` | 4 h | `[ ]` defer to v0.2 |
| P8 | About dialog: add version string (read from package.json) | `AboutDialog.tsx` + `vite.config.ts` (`__APP_VERSION__` define) + `vite-env.d.ts` | 5 min | `[x]` |
| P9 | Properties dialog: surface Created / Modified / Author dates from `coreProps` | `PropertiesDialog.tsx` + `pptx-import.ts` (extractCoreProps + resources passthrough) + `en.json` | 30 min | `[x]` |
| P10 | Recent files: show first-slide thumbnail next to each row | `RecentFilesDialog.tsx` | 1 h | `[ ]` defer |

---

## Coordination notes for the parallel UI/UX lane

These files have uncommitted edits in the parallel lane right now — I will pick them up once the lane lands a commit, to avoid re-reading mid-flight state:

- `Toolbar.tsx` (S2 inline buttons + P4 slideshow CTA + S3 Toolbar-side removal)
- `TitleBar.tsx` (S1 menus + S5 icons + P1 brand size + P2 saved chip)
- `AboutDialog.tsx` (P8 version)
- `SlideRail.tsx` (P3 hover actions)

For each, when the parallel lane is at a clean point, I'll grep the file for the audit-cited line ranges, confirm structure hasn't drifted, then make the change.

---

## Order of operations

1. **`[~] in flight`** — S4 default title, S3 status-bar Present icon, P6 Page Setup presets, P9 Properties dates. Work these now (clean files).
2. **`[c] coordination`** — wait for parallel lane's commit, then S2 + P4 (both in `Toolbar.tsx`, same surface) in one pass.
3. **`[c]`** — S1 + S5 + P1 + P2 in `TitleBar.tsx`, one pass.
4. **`[c]`** — P3 in `SlideRail.tsx`, P8 in `AboutDialog.tsx`.
5. **Deferred (`[ ]`)** — P5 (opacity, blocked on Univer fork patch), P7 (theme side panel, 4h refactor), P10 (recent-files thumbnails, 1h).

## Verification gates between batches

After each batch:
- `pnpm typecheck` ✓
- `pnpm test:unit` ✓
- Drive the affected surface in the dev server (browser smoke)
