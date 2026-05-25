<div align="center">

# Casual Slides

**PowerPoint-flavored web presentations with real-time collaborative editing**

[![Deploy](https://github.com/schnsrw/slides/actions/workflows/deploy-pages.yml/badge.svg?branch=main)](https://github.com/schnsrw/slides/actions/workflows/deploy-pages.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![Status](https://img.shields.io/badge/status-P0%20spikes-orange)](./PLAN.md)

[Architecture →](./docs/ARCHITECTURE.md) &nbsp;·&nbsp; [Univer Slides gaps →](./docs/UNIVER_SLIDES_GAPS.md) &nbsp;·&nbsp; [Sister: Casual Sheets →](https://github.com/schnsrw/sheets)

</div>

---

Casual Slides is a web-based, self-hostable presentation editor that looks and behaves like Microsoft PowerPoint — ribbon, slide-panel thumbnails, file-centric workflow — with real-time multi-user co-editing. Upload a `.pptx`, share a link, edit together.

Sister product to [Casual Sheets](https://github.com/schnsrw/sheets). Both are built on [Univer OSS](https://github.com/dream-num/univer) (Apache-2.0). Slides reuses sheets' self-host platform — admin panel, WOPI, JWT auth, webhooks, Docker shell — patterns lifted wholesale.

> 🛠 **Status: P0 — Spikes.** The bootstrap is up, the docs are written, and the first Univer fork-patch (rev tracking) is live. The pptx round-trip and collab layer are next. See [`PLAN.md`](./PLAN.md).

---

## ✨ What's planned

### Presentation engine

- Office-style ribbon — **Home · Insert · Design · Transitions · Animations · Slide Show · View · Review**
- **Slide-panel thumbnails** on the left rail · reorder · duplicate · hide · section headers
- **PowerPoint-shaped data model** — pages, masters, layouts, notes pages, theme color scheme
- Page elements: text frames, shapes, images, lines/connectors, tables, charts, video
- Transforms: position, size, rotation, scale, skew, flip
- **Master / layout editor** — full Slide Master view mode
- **Speaker notes** + presenter view (current · next · notes · timer)
- **Animations and transitions** — per-element timeline, per-page transitions
- **Theme picker** — color + font scheme catalog
- Office-shape keyboard shortcuts: Ctrl+M (new slide), F5 (present), …

### File I/O

| Format | Open | Save / Export |
| --- | :---: | :---: |
| `.pptx` | 🚧 P0 spike | 🚧 P1 |
| `.pdf` | — | 🚧 P5 (export only) |

- Parsing runs entirely in **Web Workers** — multi-MB decks don't block the main thread
- Round-trip strategy: map OOXML PresentationML → Univer's `ISlideData`; passthrough unmapped XML via `resources["CASUAL_SLIDES_PPTX_RAW"]` (same trick sheet uses for VBA + pivots)
- Full pipeline spec: [`docs/PPTX_PIPELINE.md`](./docs/PPTX_PIPELINE.md)

### Co-editing (P2)

- Yjs CRDT + Hocuspocus, lifted wholesale from sheet
- **Y.Doc shape mirrors `ISlideData`** — pages, elements, masters, layouts, resources
- Peer cursors anchored to element handles; live-typing ghost inside text frames
- Presence avatars, divergence detector, joiner fast-path with gzip-streamed snapshot
- Same room model as sheet: anonymous URLs, password-protected rooms, view-only role enforced at the engine layer

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the system diagram and Y.Doc shape.

### Self-host platform (P6)

Lifted from sheet — `host.Integration` interface (memory / local / S3 / postgres), WOPI endpoints, JWT auth, admin panel at `/admin`, 9 webhook events with HMAC-SHA256 signing, multi-arch Docker image.

---

## 🪛 Univer fork strategy

Univer's slides packages are real but have gaps the upstream hasn't filled yet. We track them in [`docs/UNIVER_SLIDES_GAPS.md`](./docs/UNIVER_SLIDES_GAPS.md) (10 gaps). For each gap:

1. Land the change in the fork at [`schnsrw/univer-revamp`](https://github.com/schnsrw/univer-revamp) on a `slide/<tag>` branch.
2. Open the upstream PR to `dream-num/univer`.
3. Mirror the same diff as a `pnpm patch` artifact under [`patches/`](./patches/) so production builds get the fix without waiting for an upstream release.

The first patch is already live:

| # | Branch | What | Status |
|---|---|---|---|
| Gap 1 | [`slide/rev-tracking`](https://github.com/schnsrw/univer-revamp/tree/slide/rev-tracking) | `getRev` / `setRev` / `incrementRev` on `SlideDataModel` | ✅ patched here, upstream PR pending |
| Gap 2 | `slide/element-mutations` | Route element ops through `CommandType.MUTATION` + COMMAND pairs with inverses (collab + undo blocker) | ⏳ next |
| Gap 3 | `slide/element-{table,chart,line,video}` | New page-element types | ⏳ P4 |
| Gap 8 | `slide/facade-api` | `FSlide` / `FPage` / `FElement` facade | ⏳ P1 ongoing |

---

## 🛠 Develop

**Prerequisites:** Node ≥ 18.17, pnpm 10+.

```sh
pnpm install               # install workspace dependencies + apply patches
pnpm dev:web               # Vite  →  http://127.0.0.1:5373
pnpm typecheck             # tsc across all packages
pnpm build:web             # production bundle
```

The dev server boots the Spike A bootstrap — a 3-page deck rendered via `@univerjs/slides` + `@univerjs/slides-ui` with native chrome hidden. Open the devtools console and run `__slideRevProbe()` to confirm the rev-tracking patch is live (prints `before=1 after=2`).

---

## 📁 Repo layout

```
.
├── apps/
│   └── web/                     # Vite + React frontend
│       └── src/
│           ├── App.tsx           # spike banner + UniverSlide
│           ├── UniverSlide.tsx   # Univer Slides mount
│           ├── default-slide.ts  # inline default deck (until pptx import lands)
│           ├── main.tsx
│           └── styles.css
├── docs/
│   ├── ARCHITECTURE.md          # system design
│   ├── RESEARCH.md              # Univer Slides 0.24 technical brief
│   ├── UNIVER_SLIDES_GAPS.md    # 10 gaps + fork-patch plan
│   └── PPTX_PIPELINE.md         # pptx I/O pipeline
├── patches/
│   ├── README.md                # pnpm patch authoring workflow
│   └── @univerjs__slides@0.24.0.patch   # Gap 1 rev tracking
├── PLAN.md                       # phased plan (P0–P6)
└── CLAUDE.md                     # project guardrails for AI-assisted development
```

The Univer fork lives in a separate repo: [`schnsrw/univer-revamp`](https://github.com/schnsrw/univer-revamp). We consume `@univerjs/*` from npm at v0.24.0 and apply patches; the fork is for upstream PR authorship.

---

## 🧱 Stack

| Concern | Choice |
| --- | --- |
| Slide engine | Univer OSS (`@univerjs/slides` + `slides-ui`, pinned to 0.24.0, patched via `pnpm patch`) |
| Frontend | React 18 + Vite + TypeScript (strict mode) |
| Lint / format | ESLint 9 + Prettier (TBD) |
| pptx export | PptxGenJS (MIT) — planned P1 |
| pptx import | JSZip + fast-xml-parser → `ISlideData` (custom) — planned P0 Spike B |
| Collab transport | Yjs (CRDT) + Hocuspocus over WebSocket — planned P2 |
| Collab server | Fastify + Hocuspocus, lifted from `schnsrw/sheets` — planned P2 |
| Persistence | Redis — optional, 7-day TTL — planned P2 |
| Self-host | Docker (multi-arch) + WOPI + JWT + admin + webhooks, lifted from `schnsrw/sheets` — planned P6 |

---

## 🚫 Explicit non-goals

- **No 100% PowerPoint feature parity** — "clearly familiar to Office users" is the bar, not pixel-perfect.
- **No persistence / accounts** in v0.0.x — anonymous sessions by room URL. JWT lands in v0.1.
- **No AI / LLM features** — the Univer command bus is extensible; wire your own model in later.
- **No mobile** in v0.0.x — desktop browsers only. Mobile viewer back-ports in v0.1, same approach as sheet.
- **No Univer Pro** — everything is built on OSS. Missing features are built here or deferred.

---

## 📄 License

Apache-2.0. See [`LICENSE`](./LICENSE) (TBD).

The Univer fork at [`schnsrw/univer-revamp`](https://github.com/schnsrw/univer-revamp) retains its upstream Apache-2.0 license.
