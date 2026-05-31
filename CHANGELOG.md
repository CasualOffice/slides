# Changelog

All notable changes to Casual Slides are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow
[SemVer](https://semver.org/).

## [0.1.0] — 2026-06-01

First tagged release. See sections below for the full ship list.

First tag-eligible cut. Single-user editor is feature-complete enough for
day-to-day work on a PowerPoint-style deck — Office ribbon, slide-rail
thumbnails, layouts, themes, backgrounds, format pane, presenter view,
find-and-replace, slideshow, PDF + PNG export, IndexedDB recent files,
and a real `.pptx` round-trip. Collab is gated behind a build-time flag
until the fork-side mutation patches land.

### Added — editor

- **Format pane (right rail)** with selection-aware Position / Size /
  Fill / Border / Shadow / Opacity sections; auto-zoom + recenter when
  the pane opens or closes; `Center on slide (H / V / both)` action;
  `Arrange` section with z-order buttons (bring forward / send backward /
  bring to front / send to back).
- **Slideshow + presenter view** — two-pane current + next + notes +
  elapsed timer; B / W blackscreen; touch swipe; deferred fullscreen
  (Safari-safe); jump-to-slide by typing a number; cursor auto-hide.
- **Find & Replace** (`Ctrl+F`) with match-case / whole-word / regex,
  animated highlight, prev / next nav, replace-one + replace-all.
- **Keyboard shortcuts dialog** (`Ctrl+/`) — platform-aware modifier
  glyphs (`⌘` on macOS), search filter, sectioned catalogue.
- **Slide rail** with rendered thumbnails; drag-reorder; range / multi
  select; `Cmd/Ctrl+A` select-all; bare `Delete` removes selection.
- **Keyboard polish:** `Esc` clears canvas selection; arrow-key element
  nudge (1 px / 10 px with Shift); `Tab` / `Shift+Tab` cycle through
  page elements; `Ctrl+D` duplicates the active slide;
  `Ctrl+Shift+↑/↓` reorders the active slide; `Ctrl+Shift+0` → Fit to
  window; z-order shortcuts (`Ctrl+Shift+]/[`, `Ctrl+Alt+]/[`).
- **File menu:** `Make a copy` (duplicates the live deck under a fresh
  title); `Page setup` (Widescreen 16:9 / Standard 4:3 / custom);
  `Download slide as PNG`; `Download deck as PDF`; real slide-by-slide
  print preview.
- **Insert link** wired via `@univerjs/docs-hyper-link[-ui]`.
- **Toolbar2** — categorised `Insert ▾` and `Slide ▾` dropdowns with
  real shape icons; core formatting always visible; dead buttons
  removed; only the paragraph-group tools collapse into the More
  popover when the row overflows.
- **Recent files:** pin / favourite to keep a deck at the top.

### Added — .pptx fidelity

- Master `<p:txStyles>` title / body / other defaults inheritance (J6).
- Master `bodyStyle` per-level bullet inheritance (C19) with stepped
  indents and per-nesting-level glyphs (C19b).
- `<p:hf>` slide footer / date / slide-number opt-outs from master
  service placeholders (I5 + K4).
- `<p:bgRef idx>` resolves into `bgFillStyleLst` (A5-idx).
- Gradient fill stops harvested (A3 + D9).
- Chart data + type parsed (H2 + H3); line / pie / area charts render
  via `Rect`s (H5b — Univer's `Path` doesn't paint inside a `Group`).
- Image colour adjust + effects (E5 + E6); image-fill on shapes and
  SmartArt nodes (E5; rels lookup scoped to drawing's own rels in E5b).
- SmartArt rendered via the pre-rendered diagram drawing (H6).
- `custGeom` path → SVG `pathData` (D6).
- Image background fill on slides (gradient deliberately omitted).
- Layout picker `Apply to current` mode (not just Insert).

### Added — production hardening

- **Root error boundary** — branded recovery card with logo, reload
  button, collapsible component stack. Mounted around the React
  subtree in `main.tsx`.
- **PPTX import resilience** — 200 MB soft-cap with `formatBytes`
  reporting; OLE compound-file magic-byte sniff (`D0 CF 11 E0 …`) →
  "decrypt in PowerPoint first" message; JSZip parse failures wrapped
  → "corrupt or not a PowerPoint file"; missing `ppt/presentation.xml`
  rephrased to "missing its presentation manifest". 6 Vitest cases
  cover oversize, encrypted, garbage bytes, missing manifest,
  zero-byte and truncated downloads.
- **Autosave + crash recovery** — separate IndexedDB (`casual-slides
  -autosave`) writes the live snapshot 30 s after the latest mutation
  while dirty; cleared on Save / Open. `beforeunload` guard while
  dirty. 5 Vitest cases (load-empty / round-trip / overwrite / clear /
  deep-clone-on-save).
- **Brand refresh** — teal (`#0D9488 / #2DD4BF` gradient) replaces the
  earlier cyan. Hand-coded `public/{favicon,brand}.svg` (~1.2 KB);
  TitleBar + AboutDialog render via `<img>`. Marketing site
  `--slides` token swapped red → teal to match.
- **Semantic CSS tokens** — `--cs-error / --cs-warn / --cs-success`
  trios replace 6 previously-hardcoded literals across the live /
  error / status pills. Disabled opacity unified at MD3 `0.38`.
- **WCAG quick wins** — `--cs-text-dim` `#80868b → #6b7177`
  (`3.68:1` → `4.94:1` AA); aria-labels on icon-only Recent-files
  open + About close; aria-live on slideshow timer and recent-files
  error.

### Changed

- TypeScript: `noUncheckedIndexedAccess: true` in `apps/web/tsconfig.json`.
  33 call sites patched with safe-access patterns (non-null assertions
  after bounds checks, explicit guards, or narrowed locals).
- Vite vendor chunking — `react` + `react-dom` + `scheduler` → one
  `vendor-react` chunk; `i18next` + `react-i18next` → `vendor-i18n`.
  ~195 KB now survives app-code redeploys in the browser cache.
  Univer was deliberately *not* chunked: bucketing it broke whole-bundle
  tree-shaking and doubled the total bundle (documented in
  `vite.config.ts`).
- Collab is now gated behind `VITE_COLLAB_ENABLED` (default `false`).
  When the flag is off, `CollabProvider` ignores `?room=…` URLs and
  console-warns once. Operators who have patched the 7 known
  `TODO(collab)` paths can opt in at build time. The fork-side
  `slide.mutation.*` patches land with the Yjs migration.

### Fixed

- **Canvas-blank regression on `.pptx` import** — the boot splash was
  overlaying the freshly-mounted canvas on every `snapshot.id` change,
  and Univer's render pipeline didn't recover when the splash later
  hid. Splash is now a one-shot first-paint latch; `BusyOverlay`
  handles per-import loading affordance.
- Toolbar `tryWire` retry no longer leaks timer handles across remount.
- `CollabProvider` `tryStart` retry no longer leaks timer handles.
- Theme text colour on canvas + bullet `listType` regression (Wave 6).
- Format pane re-wires to the new model when a deck is opened.
- Presenter view: missing `currentLabel` key + tile overflow
  ("UP NEXT" cut off).
- A11y: filename input grows while editing and carries the full title.

### Security

- Static handler (`apps/server/src/static.ts`): `safeJoin` defends
  against `..` traversal (incl. percent-encoded `%2E%2E`) with a
  planted-outside-staticDir fixture file the Vitest suite verifies is
  *never* served. Every response carries `x-content-type-options:
  nosniff`. Path-traversal attempts fall back to `index.html` rather
  than leaking the resolved path.

### Infrastructure

- **Single-image Docker deploy.** Root `Dockerfile` (multi-stage:
  `deps` → `build-web` → `runtime`, Node 22 alpine, `pnpm@10.33.4`
  via corepack) produces a 517 MB image that hosts both the web
  bundle and the `/collab` WebSocket on one port. `docker-compose.yml`
  + `.dockerignore`. `OCI image labels` (`org.opencontainers.image.*`)
  baked in at build time. `HEALTHCHECK` via `wget` on `/health`.
  Drops to the `node` user.
- **`docker-publish.yml` workflow** — fires on `v*` tags, builds
  `linux/amd64 + linux/arm64` via QEMU + buildx, signs with SLSA
  provenance + SBOM, pushes the rolling tag set
  (`:0.1.0 :0.1 :0 :latest`) to Docker Hub.
- **`unit` CI job** alongside `typecheck` and `e2e`. 25 Vitest tests
  across both workspaces (`apps/web`: 11; `apps/server`: 14), ~1.2 s.
- Static-file serving added to `apps/server/src/index.ts` via the new
  framework-free handler — MIME table, streaming responses, immutable
  cache on `/assets/*`, no-cache on `index.html`, SPA fallback.
- `apps/web/.env.example` documents `VITE_COLLAB_ENABLED`.
- `tsx` moved from `apps/server/devDependencies` → `dependencies`
  (the runtime stage's `pnpm install --prod` had been stripping it,
  causing `Cannot find package 'tsx'` at container boot — bug caught
  by the docker-build verification pass).

### Known limitations

- Single-node, in-memory collab rooms — restarting the container
  drains every active room. Yjs + persistence migration lands with
  the next minor.
- 7 editing paths still write directly to the snapshot rather than
  going through the command bus (drag-reorder, theme cascade,
  find-replace, format pane, layout, background, slide context moves)
  — gated by `VITE_COLLAB_ENABLED` so they cannot ship into a shared
  room until fork-side mutations patches land (UNIVER_SLIDES_GAPS.md
  Gap 1.4).
- Desktop-only — toolbar (32 × 32) and status bar (22 h) touch
  targets are below the WCAG 2.2 AA 44 × 44 floor. No mobile layout.
- English-only locale. The `i18n/locales/en.json` schema is
  future-proofed for additional locales (~280 keys structured under
  `chrome`, `menu`, `toolbar`, `dialogs`, `slideshow`, `errors`,
  `presenter`); the language detector is hard-coded to `en` until a
  second locale lands.
- No telemetry / error reporting (Sentry, Datadog) wired. The
  `ErrorBoundary` mirrors uncaught throws to `console.error` only.
