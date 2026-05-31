<div align="center">

# Casual Slides

**Open-source self-hosted web slides editor with `.pptx` round-trip — an alternative to Google Slides, PowerPoint Online, and PPTist (deeper fidelity than the latter; closer to native Office UX than the former two).**

[![Deploy](https://github.com/schnsrw/slides/actions/workflows/deploy-pages.yml/badge.svg?branch=main)](https://github.com/schnsrw/slides/actions/workflows/deploy-pages.yml)
[![Fidelity](https://img.shields.io/badge/pptx%20fidelity-93%2F99%20%E2%9C%93-brightgreen)](./docs/FIDELITY_TRACKER.md)
[![Wave](https://img.shields.io/badge/latest-wave%2012-blue)](./docs/FIDELITY_TRACKER.md)
[![Version](https://img.shields.io/badge/version-v0.1.0-brightgreen)](./CHANGELOG.md)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

[**Live Demo →**](https://slide.schnsrw.live/) &nbsp;·&nbsp; [Architecture →](./docs/ARCHITECTURE.md) &nbsp;·&nbsp; [Fidelity tracker →](./docs/FIDELITY_TRACKER.md) &nbsp;·&nbsp; [Univer Slides gaps →](./docs/UNIVER_SLIDES_GAPS.md) &nbsp;·&nbsp; [Product page →](https://schnsrw.live/casual-slides/)

</div>

---

Casual Slides is a **self-hostable, browser-based slides editor** that looks and behaves like Microsoft PowerPoint — Office-style ribbon (Home · Insert · Design · Transitions · Animations · Slide Show · View · Review), slide-panel thumbnails, layouts, themes, file-centric workflow. Upload a `.pptx`, edit it like the web, save it back. **Deep OOXML PresentationML round-trip — 68 of 87 fidelity probes ✅** after wave 7o.

**Compares to:** Google Slides · Microsoft PowerPoint Online · PPTist · OnlyOffice Presentation Editor.

Built on [Univer OSS](https://github.com/dream-num/univer) (Apache-2.0) — the OSS variant, **never the Pro package** — with a fork-and-patch layer for the gaps Univer hasn't filled (collab rev tracking, element mutations as `CommandType.MUTATION`, new `IPageElement` variants for tables/charts/video). Sister projects: [Casual Sheets](https://github.com/schnsrw/sheets) (`.xlsx`, v0.2.1) and [Casual Editor](https://github.com/schnsrw/docx) (`.docx`).

> 🎉 **Status: v0.1.0 (2026-06-01) — first tagged release.** Single-user editor works end-to-end with `.pptx` round-trip; Office ribbon, layouts, themes, backgrounds, format pane, presenter view, find-and-replace, slideshow, PDF + PNG export, recent files, autosave, error boundary, Docker self-host all live. **Co-edit is gated behind `VITE_COLLAB_ENABLED`** (default off) — the existing raw-WebSocket broadcast remains a single-active-editor spike; the Yjs + Hocuspocus migration ([Casual Sheets has it](https://github.com/schnsrw/sheets/blob/main/docs/PRODUCTION_PIPELINE.md)) is the v0.2.0 target. See [`CHANGELOG.md`](./CHANGELOG.md).

---

## ✨ What works today

### Presentation engine

- **Office-style ribbon** — Home · Insert · Design · Transitions · Animations · Slide Show · View · Review
- **Slide-panel thumbnails** on the left rail · reorder · duplicate · hide · context menu (right-click → duplicate / hide / delete / new)
- **6 layout templates** picked from the toolbar Layout dropdown (title slide · title + content · two content · comparison · blank · section header)
- **Theme picker** + **background picker** (solid + gradient fills)
- **Slide Show mode** (F5) with keyboard navigation
- **Notes panel** for speaker notes
- **Recent files** dialog backed by IndexedDB
- **Properties dialog** · **About dialog** · **Help → Report a Bug** (GitHub issue prefill)
- **PowerPoint-shaped data model** — pages, masters, layouts, notes pages, theme color scheme, theme fonts

### File I/O

| Format | Open | Save / Export |
| --- | :---: | :---: |
| `.pptx` | ✅ | ✅ |
| `.pdf` | — | 🚧 wave 8+ (export only) |

- Parsing + serialisation runs entirely in **Web Workers** — multi-MB decks don't block the main thread
- **2 493 LOC `pptx-import.ts`** covering deep OOXML PresentationML: slides, layouts, masters, themes, theme color resolution, placeholder inheritance, gradient fills, text outline + arrowheads + effects, hyperlinks via custom ranges, tables + charts as `IPageElement`, picture backgrounds, hidden slides, text wrap, autofit, body rotation, image cropping, connectors, RTL, strikethrough/baseline, bullets + indent + line spacing, multi-run rich text + paragraph alignment, color modifiers + rotation + flips
- Export via **PptxGenJS** (MIT)
- Round-trip strategy: map OOXML → Univer's `ISlideData`; passthrough unmapped XML (`notesSlides`, `comments`, `diagrams`, `ink`, raw layout/master/theme) via `ISlideData.resources["CASUAL_SLIDES_PPTX_RAW"]`
- **68 / 87 fidelity probes ✅** in [`docs/FIDELITY_TRACKER.md`](./docs/FIDELITY_TRACKER.md). Wave 7o snapshot.
- Full pipeline spec: [`docs/PPTX_PIPELINE.md`](./docs/PPTX_PIPELINE.md)

### Co-editing — Phase 2 spike (Yjs migration queued)

Today's collab is the v0.0.x "good enough for one editor at a time" spike:

- 104-line raw `ws` + `node:http` server in `apps/server/`
- 173-line bridge that broadcasts mutations via JSON envelopes; sufficient for single-active-editor sessions
- Anonymous rooms by URL · presence callbacks · echo-loop guard via `fromCollab` flag

**Yjs + Hocuspocus migration is the v0.1.0 blocker.** Same shape Casual Sheets uses ([`apps/server/src/index.ts`](https://github.com/schnsrw/sheets/blob/main/apps/server/src/index.ts) — Fastify + Hocuspocus + rate limit + room cap + replay retry + dead-letter). The migration is mechanical port work; what's holding it is fidelity-first investment.

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the system diagram and target Y.Doc shape.

### Self-host

**One image, one port.** The repo's root `Dockerfile` is a multi-stage build (deps → build-web → runtime) that produces a single `node:22-alpine` image. The runtime serves the built Vite bundle from `apps/web/dist` *and* the `/collab` WebSocket relay on the same port — no nginx, no reverse-proxy WS plumbing.

```sh
docker build -t schnsrw/casual-slides:latest .
docker run -p 3000:3000 schnsrw/casual-slides:latest
# open http://localhost:3000
# verify: curl http://localhost:3000/health → {"ok":true,"rooms":N,"ts":…}
```

Or via the included `docker-compose.yml`:

```sh
docker compose up -d
```

**Heads up — single-node, in-memory rooms.** Restarting the container drains every active room. The Yjs + persistence migration lands with v0.1.0 (see Roadmap below); until then, treat the image as a session-only relay.

Build args worth knowing about:

| Build arg | Default | What it does |
|---|---|---|
| `VITE_COLLAB_ENABLED` | `true` | Whether the bundle honours `?room=…` URLs. Flip to `false` to ship a static-only deploy where the gate stays closed. |
| `CASUAL_VERSION` / `CASUAL_GIT_SHA` / `CASUAL_BUILD_DATE` | `dev` / `unknown` / `unknown` | OCI image labels — set by the publish workflow at tag time so `docker inspect` shows provenance. |

The `docker-publish.yml` workflow (triggered on `v*` tags) builds multi-arch (`linux/amd64`, `linux/arm64`), signs with SLSA provenance + SBOM, and pushes the rolling tag set (`:0.1.0`, `:0.1`, `:0`, `:latest`) to Docker Hub.

**Roadmap (P6, post-v0.1):** lift sheet's full self-host platform — `host.Integration` interface (memory / local / S3 / postgres), WOPI endpoints, JWT auth, admin panel at `/admin`, 9 webhook events with HMAC-SHA256 signing. Today's image is single-node, in-memory rooms.

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

Apache-2.0. See [`LICENSE`](./LICENSE).

The Univer fork at [`schnsrw/univer-revamp`](https://github.com/schnsrw/univer-revamp) retains its upstream Apache-2.0 license. The `pnpm patch` artifacts under [`patches/`](./patches/) are derived from that fork and are also Apache-2.0.
