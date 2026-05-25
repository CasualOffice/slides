# Casual Slides — Plan

Web-based PowerPoint-equivalent with real-time co-editing.
Upload `.pptx` → open in a shared room → multiple users edit together, anonymously, no accounts.

Sister product to [`Casual Sheets`](../sheet/PLAN.md). Reuses the same self-host platform, collab bridge, and Office-shell skeleton.

---

## Scope

### In scope
- Office UX: ribbon, slide-panel thumbnails, file-centric workflow.
- Upload `.pptx` → open in a shared room → download back as `.pptx`.
- Multi-user co-editing in real time (cursors, selections, live typing).
- In-memory sessions identified by room URL.
- Optional Redis persistence for sessions that survive server restarts.
- Self-host parity with sheet (WOPI · JWT · admin · webhooks · Docker).

### Out of scope (deferred)
- **Persistence / WOPI** — until v0.1.
- **Auth / accounts** — anonymous rooms in v0.0.x; JWT in v0.1.
- **AI / LLM features** — plug into Univer command bus later.
- **Mobile** — back-port a viewer + light editor at v0.1 (same approach as sheet).

### Out of scope (forever)
- 100% PowerPoint feature parity.
- Pixel-perfect Office clone.
- Pro Univer features (we build everything on OSS).

---

## Phase plan

### 🔄 Phase 0 — Spikes (current)

Three risks to prove before Phase 1 code:

- **Spike A — Univer Slides bootstrap.** Mount `@univerjs/slides + slides-ui` in a Vite + React shell, hide native chrome, render a default deck, add+delete text/shape/image elements via slide operations. Confirm the bootstrap is as clean as sheet's `UniverRoot.tsx`.
- **Spike B — pptx round-trip.** Pick 5 representative real-world decks. Parse with `JSZip + fast-xml-parser` → `ISlideData` → export with `PptxGenJS`. Define what "acceptable fidelity" means in writing. See [`docs/PPTX_PIPELINE.md`](./docs/PPTX_PIPELINE.md).
- **Spike C — Univer collab patch.** Validate the fork patch path for `SlideDataModel.getRev/setRev/incrementRev` and routing element-edit mutations through `CommandType.MUTATION`. See [`docs/UNIVER_SLIDES_GAPS.md`](./docs/UNIVER_SLIDES_GAPS.md).

Phase 0 done = three spike PRs merged or rejected with a written decision.

### ⏳ Phase 1 — Single-user PowerPoint-flavored editor

- Custom Office-style ribbon: **Home · Insert · Design · Transitions · Animations · Slide Show · View · Review**.
- Slide-panel thumbnail strip (left rail). Reorder, duplicate, hide, section headers.
- Status bar: slide count, zoom, presence avatars.
- Full pptx open + save, worker-side. (ODP + PDF export deferred.)
- All major PowerPoint keyboard shortcuts (Ctrl+M new slide, F5 present, etc.).
- Playwright e2e harness wired (parallel to sheet's 337-test suite).

### ⏳ Phase 2 — Real-time co-editing

- Hocuspocus server + Yjs bridge plugin (lifted from sheet).
- Y.Doc mirror of `ISlideData` (see [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md#collab-bridge--yjs-document-shape)).
- Room lifecycle, share URL, password-protected rooms (sheet's `apps/server/` is reusable as-is).
- View-only role enforced at Univer engine layer.
- Redis persistence (optional, 7-day TTL).
- Joiner fast-path: gzip-streamed snapshot.

### ⏳ Phase 3 — Presence + polish

- Peer cursors anchored to element handles (not cells — element corners or text-frame caret).
- Live-typing ghost inside text frames.
- Presence avatars with active/last-seen tooltips.
- "Waiting to reconnect" banner.
- Divergence detector.
- Session history panel.

### ⏳ Phase 4 — Feature breadth

- **Page element types Univer doesn't model yet**: tables, charts, lines/connectors, videos. All require fork patches; see `UNIVER_SLIDES_GAPS.md`.
- **Master/layout editor** — Univer ships the model, we ship the UI.
- **Speaker notes panel** — `notesMaster` is in the model.
- **Slide sections** — group slides into sections in the panel.
- **Theme picker** — color schemes + font sets.
- **Animations / transitions modeling** — store in `resources` plugin slot; upstream-eligible.

### ⏳ Phase 5 — Presenter mode + show

- Full-screen present mode (F5).
- Speaker view: current + next slide + notes + timer.
- Pointer / laser / pen during show.
- Keyboard nav, exit, end-of-deck handling.

### ⏳ Phase 6 — Self-host platform

Lift wholesale from sheet — `host.Integration`, WOPI endpoints, JWT auth, admin panel, webhook dispatcher, OCI image. Roughly a week of integration work, not a month.

---

## Architecture reference

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

| Concern | Pick |
| --- | --- |
| Slide canvas + scene graph | Univer OSS Slides (forked, v0.24.x target) |
| Frontend | React 18 + Vite + TypeScript strict |
| Collab | Yjs + Hocuspocus over WebSocket |
| pptx export | PptxGenJS (MIT) |
| pptx import | JSZip + fast-xml-parser → `ISlideData` (custom) |
| Workbook persistence | `host.Integration` interface (from sheet) |
| Room persistence | Redis optional, 7-day TTL |
| Auth | JWT (HS256), same claims as sheet |
| Admin | `/admin` React panel (reused) |
| Webhooks | Same 9 events as sheet, plus slides-specific |
| Container | Multi-arch (amd64 + arm64), OCI-labelled |

---

## Status board

| Phase | Status | Tag |
| --- | --- | --- |
| P0 — Spikes | 🔄 in progress | — |
| P1 — Editor | ⏳ pending | v0.0.1 |
| P2 — Collab | ⏳ pending | v0.0.2 |
| P3 — Presence | ⏳ pending | v0.0.3 |
| P4 — Breadth | ⏳ pending | v0.0.4 |
| P5 — Presenter | ⏳ pending | v0.0.5 |
| P6 — Self-host | ⏳ pending | v0.1.0 |
