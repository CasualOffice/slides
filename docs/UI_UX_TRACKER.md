# UI / UX Parity Tracker

Goal: industry-standard editor UX — match Google Slides feel + parity feature set.
Constraint: **SVG icons only, no emoji, no icon fonts**.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked · `[-]` won't fix

Last update: 2026-05-30 — **Brand refresh (cyan → teal) + Wave 0 production-hardening pass landed in working tree**. Logo redrawn (`brand.svg`, `favicon.svg`), token system collapsed to one accent family + semantic error/warn/success tokens, disabled opacity unified at MD3 0.38. Wave 0 fixes: root error boundary, busy overlay on Open/Save, pptx import resilience (size/encryption/corrupt detection with friendly messages), autosave to IDB + dirty `beforeunload` guard + restore banner, WCAG quick wins (`--cs-text-dim` 4.94:1, aria-labels on icon-only buttons, aria-live on slideshow timer, error banner role=alert). Previous: a572cbb Format pane + Slideshow presenter, 2266296 Find &amp; Replace, 0dc12d6 layout clamp.

---

## Foundational principles (apply to every change)

- **i18n via `react-i18next`** — every user-visible string flows through `t('namespace.key')`. English locale (`en`) only for now, but `apps/web/src/i18n/locales/en.json` structure must be future-proofed for adding `es`, `zh`, etc. Namespaces per feature: `chrome`, `toolbar`, `dialogs`, `slideshow`, `errors`.
- **Material Design 3 / Google Slides interaction grammar** — 8 px spacing grid, 4 px radius for inputs / 8 px for containers, motion durations 80-180 ms cubic-bezier(0.4, 0, 0.2, 1), elevation tokens via box-shadow scale, hover/focus/active/disabled states on every interactive element.
- **Keyboard first** — every action reachable by keyboard, every shortcut documented in a `Ctrl+/` overview dialog, focus rings visible.
- **Accessibility** — WCAG 2.2 AA contrast (≥ 4.5:1 text, ≥ 3:1 UI), `aria-modal` + focus trap on dialogs, `aria-live` for transient status, screen-reader labels on every icon-only button.
- **No emoji, no icon fonts, no unicode arrows in labels.** Inline SVG only.
- **Optimistic UI for collab-bound actions** — every command goes through `slide.mutation.*` so Phase 2 collab gets it for free.

---

## Wave 0 — production hardening (landed 2026-05-30, in working tree)

Higher-leverage than any open Wave-5 bucket — these are the gaps that
made the editor feel pre-beta to a discerning user. All six are now
implemented; commit + push pending.

### Bucket H0 — Brand consolidation
- [x] `:root` accent swapped cyan-600 → teal-600 (`#0D9488`); `--cs-accent-dk`, `--cs-accent-bg`, `--cs-focus` aligned; added `--cs-accent-bg-hv` for primary-button hover (was hardcoded `#fde2d4` orange).
- [x] New semantic tokens `--cs-error / --cs-error-bg / --cs-error-border`, `--cs-warn` trio, `--cs-success` trio. Six previously-hardcoded literals in `.cs-titlebar__pill--error`, `.cs-titlebar__live--{live,connecting,error}`, `.cs-recent__error` now pull from tokens.
- [x] `--cs-disabled-opacity: 0.38` — Material spec; replaces `.45 / .55 / .35 / .60` variants across 7 selectors.
- [x] Old cyan rgba `rgba(8, 145, 178, ...)` (find-replace highlight ring + focus shadow) repainted to teal `rgba(13, 148, 136, ...)`.
- [x] ThemePicker "Classic" theme accent `#0891B2 → #0D9488`.
- [x] Brand mark redrawn — clean 32×40 hand-coded SVG (`public/brand.svg`, `public/favicon.svg`) with teal/emerald gradient page + folded corner + centered play disc. TitleBar and AboutDialog reference it via `<img src>` instead of inline SVG.
- [x] Marketing site (`../site`) `--slides` token swapped red-700 → teal-600 to match. Logo asset mirrored to `../site/public/slides-logo.{svg,png}`.

### Bucket H1 — Root error boundary
- [x] `shell/ErrorBoundary.tsx` — class component with `componentDidCatch`, fallback renders a branded card (logo + title + lede + Reload button + collapsible stack). Mounted in `main.tsx` around the App + provider subtree.
- [x] `dialogs.errors.boundary.*` i18n keys (`title`, `lede`, `reload`, `detailsLabel`).
- [x] `console.error` mirror so a future Sentry/Datadog sink picks it up automatically.

### Bucket H2 — Busy overlay (perceived performance)
- [x] `shell/BusyOverlay.tsx` — renders inside `.cs-workspace` when `opening || saving`. Spinner + label, `role="status"`, `aria-busy="true"`, pointer-events block so the user can't reach the canvas mid-load.
- [x] `.cs-spinner` reusable utility (28 px brand-tinted ring, 0.8 s rotation, `prefers-reduced-motion` honoured).
- [x] `chrome.workspace.busy{Opening,Saving}` i18n keys.

### Bucket H3 — PPTX import resilience
- [x] `pptx-import.ts` top-of-`importPptxToSlides`:
  - 200 MB soft cap with `formatBytes` reporting — refuses oversized files before JSZip allocates inflate buffers.
  - OLE compound-file magic-byte sniff (`D0 CF 11 E0 A1 B1 1A E1`) → "password-protected, decrypt in PowerPoint first" message.
  - JSZip.loadAsync wrapped → "corrupt or not a PowerPoint file" with the underlying cause.
  - "presentation.xml not found" rephrased to user-readable "missing its presentation manifest".
- [x] Errors cross the worker boundary as strings (current shape) and surface in App.tsx's existing `error` pill verbatim.
- [x] `errors.pptx{TooLarge,Corrupt,Encrypted}` i18n keys seeded for the eventual W1b migration.

### Bucket H4 — Autosave + crash recovery
- [x] `storage/autosave.ts` — separate IDB (`casual-slides-autosave`) with a single `current` row keyed on `key`. `saveAutosave`, `loadAutosave`, `clearAutosave`; quota / private-mode failures swallowed to `console.warn`.
- [x] App.tsx: 30 s debounced autosave on every `dirty` snapshot change; cleared on Save success and on Open (the new deck replaces any pending recovery record).
- [x] App.tsx: `beforeunload` guard registered only while `dirty` — browsers show their native "leave site?" dialog.
- [x] `shell/AutosaveRestoreBanner.tsx` — bottom-anchored snackbar offered on mount IF the user is still on `DEFAULT_SLIDE_DATA`. Restore replaces the snapshot (marks dirty so the next Save promotes it); Dismiss `clearAutosave()`s.
- [x] `chrome.autosave.{title,subtitle,restore,dismiss}` i18n keys; `formatRelative` for the timestamp.

### Bucket H5 — WCAG 2.2 AA quick wins
- [x] `--cs-text-dim` `#80868b` → `#6b7177` — was 3.68:1 (fail), now 4.94:1 (AA body text).
- [x] `RecentFilesDialog` Open button gained `aria-label`; error pill gained `role="alert"` + `aria-live="assertive"`.
- [x] `AboutDialog` close button gained `aria-label`.
- [x] `PresenterView` elapsed timer: explicit `aria-live="off"` + `aria-label` so the value is readable on focus without announcing every second.
- [x] `presenter.elapsedAria` i18n key.
- [x] Slideshow counter + FormatPane collapsibles confirmed already wired (`aria-live="polite"` and `aria-expanded` respectively).

### Bucket H6 — Tracker maintenance
- [x] Brand-colour decision (line ~273) updated from cyan to teal.
- [x] Bucket I replaced with concrete items (see new Bucket I below).

### Not yet (deliberate cut for this pass)
- [x] Initial splash while Univer boots — `shell/UniverBootSplash.tsx` paints over the canvas area while Univer's plugin lifecycle warms up. Logo + small spinner + "Starting the editor…" copy. App.tsx flips it off ~120 ms after `SlideDataModel` is reachable inside the existing `wire()` effect; 8 s safety net so a hung engine doesn't strand the user; resets on `snapshot.id` change so Open/import remount also shows the splash. `prefers-reduced-motion` honoured. New `chrome.workspace.bootSplash` key; new `.cs-spinner--sm` variant.
- [ ] `noUncheckedIndexedAccess` + `as any` cleanup.
- [x] Code-splitting — `React.lazy` on 6 modally-shown surfaces (SlideShow, ThemePicker, PageSetupDialog, PropertiesDialog, RecentFilesDialog, AboutDialog) wrapped in a single `<Suspense fallback={null}>` block in `App.tsx`; gated on the `open` boolean so the chunk import only fires on first activation. Plus dynamic `await import('./shell/download-slide')` at the PNG / PDF call sites so `html-to-image` + `jsPDF` aren't paid until a user clicks Download. Emits 6 small lazy chunks (3–10 KB each) + keeps the ~200 KB `html2canvas` chunk genuinely deferred behind a click. Net main-bundle effect is modest — the dialogs themselves were small — but the Download path is now the only entry to the heaviest non-Univer dep. Bigger gain (Univer vendor split via `manualChunks`) is a follow-up.
- [x] `setInterval` / `setTimeout` cleanup audit — auditor flagged 8 sites; actual count was 2 hygiene fixes (Toolbar `tryWire`, CollabProvider `tryStart` retry timeouts now capture + clear their handles in the effect cleanup). All other 22 sites were already correctly captured + cleared.
- [x] CI infrastructure — `.github/workflows/ci.yml` now runs three jobs in parallel: `typecheck`, **`unit`** (Vitest 1.6 + fake-indexeddb), and `e2e` (Playwright). Unit specs cover the two highest-leverage new modules: `src/storage/autosave.test.ts` (5 tests — null on empty, save+load roundtrip, overwrite semantics on the single-row store, clear, deep-clone-on-save proof) and `src/pptx/pptx-import.test.ts` (4 tests — 200 MB size cap, OLE magic-byte detection of password-protected files, JSZip parse failure → "corrupt" message, real ZIP without `ppt/presentation.xml` → "missing manifest" message). Pinned to vitest 1.x for Vite 5 peer compatibility. `pnpm test:unit` from root; `pnpm test` / `pnpm test:watch` inside `apps/web/`. 9 tests, ~1 s wall clock.
- [x] Collab feature gate — `VITE_COLLAB_ENABLED` (default `false`). `CollabProvider` early-returns on `?room=…` if the flag isn't `'true'`, console-warns once so the operator sees the reason in devtools. `apps/web/.env.example` documents the flag; `apps/web/src/vite-env.d.ts` carries the typed contract; `playwright.collab.config.ts` opens the gate for the multi-tab spec via `webServer.env`. Still TODO upstream: the 7 `TODO(collab)` editing paths (drag-reorder, theme cascade, find-replace, format pane, layout, background, slide context moves) still bypass the command bus — this gate keeps them out of shared rooms until fork-side `slide.mutation.*` patches land (UNIVER_SLIDES_GAPS.md Gap 1.4).
- [x] Dockerfile + deploy story — **single image, single port** (mirroring sheet's pattern per CLAUDE.md): one `node:22-alpine` runtime hosts both the Vite-built bundle AND the `/collab` WebSocket relay. Static-file serving added to `apps/server/src/index.ts` via the new `apps/server/src/static.ts` (MIME table, streaming responses, `safeJoin` traversal guard, immutable cache on hashed `/assets/*`, no-cache on `index.html`, SPA fallback). Root `Dockerfile` is multi-stage (deps → build-web → runtime); `.dockerignore` keeps the image lean; `docker-compose.yml` adds restart policy + healthcheck; `.github/workflows/docker-publish.yml` builds `linux/amd64` + `linux/arm64`, signs with SLSA provenance + SBOM, and pushes rolling tags (`:0.1.0`, `:0.1`, `:0`, `:latest`) on every `v*` git tag. Smoke-tested locally: `/health` JSON, hashed-asset cache, SPA fallback, path-traversal defence all behave. README's "Self-host" section rewritten with the operator-facing build args table.

---

## Wave 1 — in flight (parallel agents, isolated worktrees)

### Bucket Z — i18n foundation (must land first)
Owner: Agent-Z (worktree, completed — awaiting merge)
Scope: install + wire `react-i18next`. English seed bundle only. Shell migrations deferred to Wave 1b.
- [x] Added `i18next ^23` + `react-i18next ^15` to `apps/web/package.json`.
- [x] `apps/web/src/i18n/index.ts` — init, `fallbackLng: 'en'`, `defaultNS: 'chrome'`, `escapeValue: false`, namespace list exported.
- [x] `apps/web/src/i18n/locales/en.json` — ~210 keys across namespaces `chrome` (14), `menu` (30), `toolbar` (36), `statusbar` (10), `notes` (6), `dialogs` (~105 inc. plural `_other` for recent files), `slideshow` (9), `errors` (2). All ASCII, no unicode arrows (`Arrow right` not `→`, `Shift+Del` not `⇧ Del`).
- [x] `apps/web/src/main.tsx` imports `./i18n` before App.
- [x] `apps/web/src/i18n/README.md` — migration recipe + add-locale flow.
- [~] Migrate `*.tsx` literals to `t()` — deferred to Wave 1b (single pass after A/B/C merge).
- Open Q: language detector not wired yet (hardcoded `lng: 'en'`) — pick detector vs explicit picker when 2nd locale lands.
- Open Q: brand strings (`PptxGenJS`, `JSZip`) keyed for symmetry; could be inlined later.

### Bucket A — SVG icon system migration
Owner: Agent-A (worktree, completed — awaiting merge)
Scope: replace Material Symbols webfont with inline SVG. `<Icon name=…>` API preserved.
- [x] `icons.tsx` rewrite — inline SVG via Lucide path data, name→ReactNode `ICONS` map. Unknown names log warning + render fallback square.
- [x] Dropped Material Symbols `<link>` from `index.html`.
- [x] Toolbar shape labels: `Arrow → / ← / ↑ / ↓` → `Arrow right / left / up / down`.
- [x] `⇧ Del` → `Shift+Del` in `SlideContextMenu.tsx:173`.
- [x] `(←)` / `(→ or Space)` → `(Left arrow)` / `(Right arrow or Space)` in `SlideShow.tsx`.
- [x] `.material-symbols-outlined` selectors removed; `.cs-icon` layout rules kept.
- [x] 45 icon names mapped; approximations for `category` (shapes triad), `slideshow` (monitor + play), `palette` (with fill dots), `shape_line` (octagon).
- [x] `pnpm tsc --noEmit` passes.
- Add-icon recipe: copy Lucide inner SVG → add entry to `ICONS` → use `<Icon name="..." />`.

### Bucket B — Status & menu wiring (the "dead UI" cleanup)
Owner: Agent-B (worktree, completed — awaiting merge)
Scope: `App.tsx`, `TitleBar.tsx`, `StatusBar.tsx`, `styles.css` (small appended section).
- [x] StatusBar: real `activeSlideIndex` via `SlideDataModel.activePage$` rxjs subscription. 200 ms poll kept ONLY for initial wiring race, then dropped.
- [x] StatusBar: **real zoom** via `IRenderManagerService.getRenderById(unitId).scene.scale(f, f)` — same API as Univer's wheel-zoom. Slider, ±, %-click-reset, View menu, Ctrl++/-/0 all drive one state.
- [x] StatusBar: dropped hardcoded `English (US)` and disabled Slide sorter button.
- [x] Edit menu: Undo / Redo / Cut / Copy / Paste wired (Univer commands first, `document.execCommand` fallback with TODO).
- [x] View menu: Fit-to-window (reset zoom + `scrollToCenter`), Zoom in/out (clamped 25–400%), Slide panel (stopgap DOM toggle on `[data-u-comp="left-sidebar"]`), Speaker notes.
- [x] Insert menu: Text box, Image, New slide. Shape currently fires a rectangle as fallback — TODO to wire to Toolbar shapes popover when Wave 2-D exposes the picker hook.
- [x] File menu: New (reloads page); Share removed.
- [x] Saved-state indicator: `dirty` flag subscribes to both `onMutationExecutedForCollab` and `onCommandExecuted` (filtered to `slide.*` minus `activate-slide` / `set-slide-page-thumb` / text-edit). Cleared on Save / Open. Works around Gap 1.4 where element ops are OPERATION not MUTATION.
- [x] Removed `Share` button + hardcoded `U` avatar.
- [x] Status + error pills dismissible via `<Icon name="close" size={10}>` × button.
- [!] Slide-panel toggle is DOM `display: none` stopgap — `ILeftSidebarService` is the proper path. Acceptable for now.
- [!] Dirty heuristic may miss exotic mutations / false-positive on some lifecycle commands. Safer once Gap 1.4 lands.

### Bucket C — Slide context menu + drag-drop import
Owner: Agent-C (worktree, completed — awaiting merge)
Scope: `SlideContextMenu.tsx`, `Toolbar.tsx` (disabled-stub removal only), `App.tsx` (drag-only), `styles.css` (appended drop-overlay section).
- [x] Context menu: Move up / Move down (disabled at boundaries).
- [x] Context menu: Hide slide / Unhide slide (toggles `slideProperties.isSkipped`, label + icon flip on state).
- [x] Toolbar: removed `pointer`, `comment`, `transition` stubs + one orphan separator.
- [x] App.tsx: drag-and-drop single `.pptx` import, extension + MIME check, error surface on non-pptx.
- [x] styles.css: `.cs-workspace__drop-overlay` (M3 elevation + dashed accent border).
- [~] Change layout / Change background from context menu — **deferred**. Pickers are owned by Toolbar local state; needs Toolbar to expose `__casualSlides_openLayout(rect)` / `__casualSlides_openBackground(rect)` globals (same shape as `__casualSlides_openThemes`). Tracked as TODO in `SlideContextMenu.tsx`. Will fold into Wave 2-D toolbar reshape.
- [!] Move up/down bypasses command bus (direct `pageOrder` swap + `incrementRev`). **TODO(collab): not collab-safe** — proper fix is fork-side `slide.mutation.move-page` per UNIVER_SLIDES_GAPS.md.
- [!] Hide-slide patch round-trips through `pptx-import.ts:4025`; PptxGenJS export side needs to honor `isSkipped` (`show=0`) — out of scope.
- [-] Paste-image from clipboard — not started; defer to a later wave.
- [~] "Drop .pptx to open" overlay string carries `TODO(i18n)` pending Wave 1b string migration.

---

## Wave 2 — in flight (parallel agents, isolated worktrees)

### Bucket W1b — i18n string migration sweep
Owner: Agent-W1b (worktree, running)
Scope: every shell `.tsx` EXCEPT `Toolbar.tsx` (W2-D rewrites it). Plus `App.tsx` drop-overlay strings only.
Files: TitleBar, StatusBar, NotesPanel, ThemePicker, BackgroundPicker, LayoutPicker, layouts.ts, PropertiesDialog, RecentFilesDialog, AboutDialog, SlideContextMenu, SlideShow, App.tsx (drop overlay strings only). Add new keys to `en.json` when literals lack one.
- [~] Replace literals with `t('namespace.key')` using seeded keys.
- [~] Pluralization with `_one` / `_other`.
- [~] tsc clean.

### Bucket W2-D — Google Slides formatting toolbar
Owner: Agent-W2D (worktree, running)
Scope: rewrite `Toolbar.tsx`, add `apps/web/src/shell/toolbar/` components, extend `icons.tsx` + `en.json` + `styles.css`.
- [~] Group layout: undo/redo/print/paint-format · text-box/image/shape/line · new-slide/layout/theme/background · **font family** · **font size** · **B / I / U / S** · **text color** / **fill color** / **outline color** · **align** · **list** · **indent ±** · **line spacing** · **clear formatting** · **insert link** · Slideshow CTA right-aligned.
- [~] FontFamilyPicker / FontSizePicker / ColorPicker / AlignPicker / ListPicker / LineSpacingPicker / OverflowPopover components.
- [~] ResizeObserver-driven overflow popover (no horizontal scroll).
- [~] aria-pressed on toggles, aria-label/title from `t()`, focus rings.
- [~] Recent colors persist in localStorage.
- [~] Univer command research — flag `TODO(univer)` where mutation isn't exposed in v0.24.0.

### Bucket W2-KB — Keyboard shortcuts overview dialog
Owner: Agent-W2KB (worktree, running)
Scope: NEW `ShortcutsDialog.tsx`, `<ShortcutsProvider />` self-mounts in `main.tsx`. New `dialogs.shortcuts.*` i18n namespace.
- [~] Ctrl+/ (Cmd+/ Mac) opens modal.
- [~] Sections: File · Edit · Slides · View · Slideshow · Help.
- [~] Search filter at top.
- [~] `<kbd>` chips, platform-aware (`⌘` on Mac).
- [~] Focus trap, Esc close, backdrop click close.

---

## Wave 3 — in flight (parallel agents, isolated worktrees)

### Bucket W3-E — Right-side Format pane
Owner: Agent-W3E (worktree)
Scope: NEW `FormatPane.tsx` + sub-section files, self-mount via `<FormatPaneProvider />` in `main.tsx`, new `dialogs.format` i18n namespace, styles.css append.
- [~] Selection-aware show/hide (subscribe Univer selection).
- [~] Position / Size / Fill / Border / Shadow / Opacity sections.
- [~] Collapsible sections with localStorage persistence.
- [~] 280 px right rail, 180 ms slide-in.

### Bucket W3-G — Slideshow + presenter view
Owner: Agent-W3G (worktree)
Scope: MOD `SlideShow.tsx`, NEW `PresenterView.tsx` + `SlideTile.tsx`, `slideshow.*` i18n, styles.css append.
- [~] Presenter view (two-pane: current + next + notes + timer).
- [~] B / W blackscreen toggles.
- [~] Touch swipe (60 px / 100 ms).
- [~] Defer auto-fullscreen until user gesture.
- [~] Counter overlay default off, reveal on mouse-move.
- [~] Jump-to-slide by typing a number.
- [~] Empty state Exit button.
- [~] Mouse-cursor auto-hide after 2 s.

### Bucket W3-J — Find &amp; replace dialog
Owner: Agent-W3J (worktree)
Scope: NEW `FindReplaceDialog.tsx` + `<FindReplaceProvider />` self-mount in `main.tsx`, new `dialogs.findReplace` namespace, styles.css append.
- [~] Ctrl+F (Cmd+F Mac) intercept, guarded for editable surfaces.
- [~] Match-case / whole-word / regex toggles (filled when active).
- [~] Search across every TEXT page-element + shape text.
- [~] Result count + Prev/Next navigation, auto-jump to matching slide.
- [~] Animated match highlight (cyan ring, 600 ms).
- [~] Replace one / Replace all (with `TODO(collab)` if direct snapshot write).
- [~] Floating top-right card, 380 px, MD3 elevation.

---

## Wave 4 — in flight (parallel agents, isolated worktrees)

### Bucket W4-Rail — Left slide rail with rendered thumbnails ✅ shipped (b27d8d1)
Owner: built in-house (both agents stalled on infra)
Scope: NEW `SlideRail.tsx` + `SlideRailThumbnail.tsx`, self-mount via `<SlideRailProvider />` in `main.tsx`, new `chrome.slideRail.*` i18n, styles.css append.
- [~] Rendered thumbnails (reuse `SlideTile` with `transform: scale`).
- [~] Click → activate; Cmd/Ctrl-click toggle; Shift-click range; Esc clears.
- [~] Drag-reorder via `pageOrder` swap (TODO(collab)).
- [~] Up/Down keyboard navigation; Cmd/Ctrl+A select all; bare Delete on selection.
- [~] Bottom "+ New slide" button.
- [~] Hide Univer's `[data-u-comp="left-sidebar"]` via CSS.
- [~] `body.cs-slide-rail-open` toggles 220 px margin-left on workspace.

### Bucket W4-F — Picker improvements (partial ✅ 7420124)
Owner: built in-house (agent stalled on infra)
- [x] ThemePicker cascades headingFont + bodyFont + accent + heading/body text colour across every slide; live "Aa" preview chip per card.
- [x] BackgroundPicker "No fill" button.
- [ ] BackgroundPicker "Image…" (PNG/JPEG) + gradient tab — deferred.
- [ ] LayoutPicker Insert vs Apply-to-current segmented control — deferred.

---

## Wave 5 — pending dispatch

### Bucket D — Google Slides toolbar (the BIG one)
Scope: `Toolbar.tsx` + new components. Industry-standard format controls.
- [ ] Font family picker (Google Fonts list from `index.html` font pack).
- [ ] Font size stepper (- / + / direct input).
- [ ] Bold / Italic / Underline / Strikethrough toggles (driven by Univer text-run mutations).
- [ ] Text color picker (theme + recent + custom).
- [ ] Fill color picker.
- [ ] Border / outline color + weight + dash style.
- [ ] Align (left / center / right / justify) + vertical align.
- [ ] List controls (bulleted / numbered / indent / outdent).
- [ ] Line spacing.
- [ ] Insert link (Ctrl+K).
- [ ] Format painter.
- [ ] Replace generic Material Symbols glyphs in Shapes menu with inline SVG previews of actual prstGeoms.
- [ ] Overflow "More" popover (replace hidden horizontal scroll).

### Bucket E — Right-side Format pane
- [ ] Right rail context-aware Format panel (Position / Size / Fill / Border / Shadow).
- [ ] Selection-driven: appears when element selected, hides otherwise.

### Bucket F — Picker improvements
- [ ] ThemePicker: cascade to font + accent + default text colour (not just background).
- [ ] BackgroundPicker: consistent flow (chip + custom both go through Apply), Reset/No-fill, image-as-background.
- [ ] LayoutPicker: "Change layout for current slide" mode (not just insert new slide).

### Bucket G — Slideshow / presenter
- [ ] Defer auto-fullscreen until user gesture (Safari).
- [ ] Presenter view (current + next slide + notes + timer).
- [ ] B/W blackscreen toggle, jump-to-slide by number.
- [ ] Touch swipe.
- [ ] Empty state Exit button on "Slide not found".
- [ ] Counter overlay defaults off, reveals on mouse-move.

### Bucket H — File menu
- [ ] Make a copy.
- [ ] Page setup (16:9 / 4:3 / custom).
- [ ] Download as PDF / PNG / JPEG.
- [ ] Real print preview (slide-by-slide, not viewport).
- [ ] Recent files pin / favorite.

### Bucket I — Accessibility pass (W0 took the quick wins; these remain)
- [ ] Touch targets — Toolbar (32×32) and StatusBar (22 h) below the WCAG 2.2 AA 44×44 floor. Decide: (a) widen, or (b) commit to "desktop only" and document.
- [ ] Canvas keyboard support — element select, arrow-nudge, Tab-cycle. Currently mouse-only outside of Univer's internal text edit.
- [ ] SlideRail focused-tile visual outline (`:focus-visible`) so the arrow-key keyboard nav announced on focus matches the visible state.
- [ ] `prefers-reduced-motion` for the find-replace dialog slide-in (the other animations already gated).
- [ ] `forced-colors: active` pass — high-contrast Windows mode currently untested.
- [ ] FindReplaceDialog `aria-modal` semantics — currently `aria-modal="false"` by design (popover-like, lets the user keep editing). Either document the exemption in a comment + commit text, or flip to true + focus-trap.
- [ ] `aria-describedby` on disabled toolbar buttons (Paint Format, Insert Link, etc.) explaining "selection required".

### Bucket J — Find & replace + keyboard
- [ ] Ctrl+F integrated find (not browser default).
- [ ] Ctrl+K insert link.
- [ ] Ctrl+/ shortcut overview dialog.
- [ ] Tab / Shift+Tab cycle element selection.
- [ ] Arrow-key nudge selection.

### Bucket K — Visual / theming consolidation
- [x] Pick one brand colour — **teal** (`#0D9488 / Tailwind teal-600`), refreshed 2026-05-30. Old cyan retired; all hardcoded fallbacks repointed; semantic tokens cover error/warn/success surfaces. See Bucket H0 above.
- [ ] Compress title bar to 56-60 px (currently 64).
- [ ] Dark mode pass (or drop `color-scheme: light dark`).
- [ ] Slide-rail thumbnails: render miniature instead of numbered list (W4 partially in flight).

---

## Critical canvas regression — RESOLVED (fd2f3ca, 2026-05-29)

**Symptom:** main slide `<canvas>` computed to width 0 — blank editing surface
(chrome/toolbar/rail all rendered fine). Blocked the chart/table fidelity work.

**Root cause:** the Wave-4 slide rail hid Univer's native sidebar with
`[data-u-comp="left-sidebar"] { display: none }`. `display:none` pulled the
sidebar out of Univer's internal flex layout; the render engine then sized the
main canvas at width 0. Bisected: canvas = 1232 at 29c5834 (pre-Wave-1), 0 at
HEAD; toggling that single rule flipped it 0 → 1220.

**Fix:** hide the native sidebar by collapsing it (width/min/max 0 + overflow
hidden + opacity 0 + pointer-events none) instead of `display:none`, keeping it
in the flex flow so the canvas gets full width. Verified the slide renders at
1220 px. Also reverted the over-aggressive `#root`/workspace/mount layout clamps
to the known-good baseline, and removed `overflow:hidden` from `.cs-titlebar`
(it was clipping the File/Edit/View dropdowns behind the toolbar — now uses
position:relative + z-index:60; verified the dropdown paints on top).

## Bug-fix pass (2026-05-29)

Verified against a headless browser on both dev + a production build:
- **Toolbar raw `toolbar.<key>` labels** (e9fad5e) — wrong i18n separator; `t('toolbar.X')` → `t('toolbar:X')` across Toolbar + all toolbar/* pickers. Verified buttons render "Undo"/"Bold".
- **Canvas collapse on selection** (e9fad5e) — FormatPane's `margin-right` shift (stacked on the rail's `margin-left`) drove Univer's column width negative ("column width less than 0"), zeroing the canvas. FormatPane is now a pure overlay; top offset corrected to `calc(titlebar+toolbar)`; `#root` grid no longer clamps the canvas cell.
- **File → Open** — confirmed working (chooser opens, clean build imports "Loaded · N slides"); the "pptx worker error" was a transient HMR artifact. Added real worker error detail.
- **Slide rail stale thumbnails after import** (aa2c2b8) — rail now polls the live unitId and re-wires to the new model on deck swap. Verified 3→0 thumbnails on a 0-slide import.

## Done

- **Wave 1 (2026-05-28, commit 5551714)** — Z (i18n foundation, ~210 keys) + A (45 SVG icons replacing Material Symbols webfont) + B (real Univer scene.scale zoom, SlideDataModel.activePage$ subscription, dirty-state Saved indicator, full Edit/View/Insert menu wiring, dismissible status/error pills) + C (slide context Move up/down/Hide, drag-and-drop .pptx import, disabled toolbar stubs removed). Pushed to origin/main.
- **Wave 2 (2026-05-28, commit 75a4eab)** — W2-D (Google Slides toolbar with font family, size ±, B/I/U/S, text+fill+border color, align, list, indent ±, line spacing, link, paint format, clear formatting, ResizeObserver overflow popover, 8 new toolbar/* components, ~70 toolbar i18n keys) + W2-KB (Ctrl+/ shortcut overview dialog with search, platform-aware kbd chips, self-mounting ShortcutsProvider). Plus full brand-to-cyan repaint: CSS tokens + favicon.svg + TitleBar/AboutDialog SVG logos + `<meta name="theme-color">`. Univer command gaps recorded as TODO(univer) on inert buttons (paint format, clear formatting, link, line spacing, shape fill/outline, vertical align).
- **Wave 2 polish (commits 9ba5c5f / e018737 / 93aa6bb / 0dc12d6)** — Killed the Material Symbols text-fallback (icon names appearing as raw text). Added 45+ Lucide-style outlined SVG bodies and filled variants for state-bearing icons. Wired `filled={isActive}` on every toggle (Bold/Italic/Underline/Strikethrough, AlignPicker, ListPicker, StatusBar view + notes). Bumped icon sizes to Google Slides spec (18 px formatting, 16 px chrome, 14 px carets). Toolbar overflow detection now measures real scrollWidth vs clientWidth. Layout clamp at every chrome region (`#root` grid + cs-titlebar + cs-toolbar + cs-statusbar + cs-workspace get `min-width: 0` + `overflow: hidden`) so the app can never bleed past viewport.
- **Wave 3 (commits a572cbb + 2266296)** — Right-side Format pane (W3-E) selection-aware with Position/Size/Fill/Border/Shadow/Opacity sections (transform props wire end-to-end via `UpdateSlideElementOperation`; non-transform props left TODO(univer) until the v0.24.0 whitelist widens). Slideshow + presenter view (W3-G) with two-pane current+next+notes+timer, B/W blackscreen, touch swipe, deferred fullscreen, jump-to-slide, cursor auto-hide. Integrated Find &amp; Replace (W3-J) with match-case/word/regex toggles, animated cyan ring highlight, replace-one + replace-all (direct snapshot write — TODO(collab) until Univer text-run mutation is reachable).
- **Wave 6 (2026-05-30)** — Export + keyboard polish, closing every concrete item in Wave 5 / Buckets H + I + J. Commits:
  - `eee53d8` — File → Download slide as PNG (offscreen SlideTile + html-to-image).
  - `e33c85d` — Toolbar Insert link via `@univerjs/docs-hyper-link[-ui]` + Ctrl+K; doc-typed plugins force-started post-`createUnit` so the operation registers globally.
  - `6549881` — File → Download deck as PDF (jspdf, sequential rasterize, status pill streams progress).
  - `a0a7366` — File → Make a copy (`structuredClone` of live snapshot, fresh id, " (copy)" title, remount via key).
  - `6eca0e4` — Arrow-key element nudge (1 px / 10 px with Shift). Bails on editable surfaces.
  - `59bbdad` — Real slide-by-slide print preview replacing viewport `window.print()`; `@page` matches native slide size, `@media print` mounts a rasterized sheet.
  - `2b6a432` — Tab / Shift+Tab cycle through page elements via `scene.getAllObjectsByOrder` + `transformer.attachTo`.
  - `1a0afcd` — Auto-zoom + recenter canvas when FormatPane opens (RAF ease-out to 85 %, restore on close).
  - `99e302e` — Filename input grows on focus (cap 600 px), full title in `title` + `aria-label`.
  - `68be48f` — Recent files pin/favorite (IndexedDB `pinned: boolean`, pinned sort first + survive 10-row trim, star icon with filled variant).

---

## Blocked / questions for user

- **Other Claude session is running on this repo** — agents below use `isolation: "worktree"` so they branch off `main` at HEAD without disturbing the live tree. Merge order matters; we'll review each before fast-forward.
- **Icon library choice**: Lucide (MIT, 1.4k icons, tree-shakable) recommended. Alternatives: Heroicons (MIT), Phosphor (MIT). Defaulting to Lucide unless overridden.
- **Brand colour**: refreshed 2026-05-30 from cyan to **teal** — `--cs-accent: #0D9488`, `--cs-accent-dk: #0F766E`, `--cs-accent-bg: #F0FDFA`, `--cs-accent-bg-hv: #CCFBF1`, `--cs-focus: #0D9488`. Still distinct from PowerPoint red, Impress orange, Google Slides yellow; new logo is a teal/emerald gradient page with a centred play disc (32×40 viewBox, hand-coded, ~1.2 KB). Memory: `[[project-brand-color]]`.
