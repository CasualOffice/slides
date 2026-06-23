# Architecture

System design for Casual Slides. For Univer internals see [`RESEARCH.md`](./RESEARCH.md). For the fork-patch plan see [`UNIVER_SLIDES_GAPS.md`](./UNIVER_SLIDES_GAPS.md). For pptx I/O see [`PPTX_PIPELINE.md`](./PPTX_PIPELINE.md).

This document describes the **target** architecture (post-P1). Open decisions are called out inline.

---

## System diagram

```
┌──────────────────────────────── Browser ─────────────────────────────────────┐
│                                                                              │
│  React app (Vite, TypeScript strict)                                         │
│                                                                              │
│  ┌──────────────── Office-style shell (apps/web/src/shell/) ───────────────┐ │
│  │  TitleBar · FileMenu · Properties dialog · Share dialog                │ │
│  │  Ribbon (Home/Insert/Design/Transitions/Animations/Show/View/Review)   │ │
│  │  SlidePanel (left-rail thumbnails) · StatusBar (count/zoom/presence)   │ │
│  │  NotesPanel · HistoryPanel · LoadingOverlay · SaveToast                │ │
│  └──────────────────────────────────────────────────────────────────────┘  │
│          │ executeCommand / FUniver API                                      │
│  ┌───────▼───────────────────────────────────────────────────────────────┐  │
│  │  Univer OSS Slides (apps/web/src/univer/) — forked                    │  │
│  │  ├─ Slide canvas + scene graph (engine-render)                        │  │
│  │  ├─ Slide data model (ISlideData)                                     │  │
│  │  ├─ Slides-UI controllers (canvas-view, slide-editing, slide-bar)     │  │
│  │  └─ ICommandService — mutation bus (PATCHED — see GAPS doc)           │  │
│  └────────────────────────────────┬──────────────────────────────────────┘  │
│                                   │ onMutationExecutedForCollab              │
│  ┌────────────────────────────────▼──────────────────────────────────────┐  │
│  │  Collab bridge (apps/web/src/collab/) — lifted from sheet             │  │
│  │  ├─ Outgoing: slide-mutation → Y.Doc update                           │  │
│  │  ├─ Incoming: Y.Doc update → syncExecuteCommand(…, { fromCollab })   │  │
│  │  ├─ Presence: cursor, selection, live-edit ghost via Awareness        │  │
│  │  └─ CollabDriver: join/leave, snapshot fast-path, divergence detect  │  │
│  └────────────────────────────────┬──────────────────────────────────────┘  │
│                                   │ Y.Doc updates / Awareness               │
│  ┌────────────────────────────────▼──────────────────────────────────────┐  │
│  │  Yjs + y-websocket provider  →  wss://host/yjs?room=<id>&p=<pw>      │  │
│  └──────────────────────────────┬─────────────────────────────────────────┘ │
│                                 │                                            │
│  ┌──────────────────────────────▼─────────────────────────────────────────┐ │
│  │  pptx worker (apps/web/src/pptx/)                                     │ │
│  │  JSZip + fast-xml-parser (import)  ·  PptxGenJS (export)              │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │ WebSocket  /yjs
                                   │ HTTP       /api/*
                                   ▼
┌──────────────────────────── Node server (apps/server/) ──────────────────────┐
│                                                                              │
│  Fastify (HTTP + static serve) — same shape as ../sheet/apps/server/         │
│  ├─ GET  /                            web app bundle                         │
│  ├─ GET  /r/:roomId                   same SPA; room context                 │
│  ├─ POST /api/rooms                   create room {password?, seed?}         │
│  ├─ GET  /api/rooms/:id/info          {needsPassword, hasSeed, clients…}     │
│  ├─ POST /api/rooms/:id/seed          multipart pptx upload                  │
│  ├─ GET  /api/rooms/:id/seed          download seed pptx                     │
│  ├─ POST /api/rooms/:id/snapshot      gzipped ISlideData upload              │
│  ├─ GET  /api/rooms/:id/snapshot      joiner fast-path fetch                 │
│  └─ GET  /health                      {ok, ts, rooms}                        │
│                                                                              │
│  Hocuspocus (WebSocket /yjs)                                                 │
│  ├─ Room registry Map<roomId, RoomState>                                     │
│  ├─ Password gate: SHA-256 + constant-time compare                           │
│  └─ Room GC: throwaway rooms evicted after TTL                               │
│                                                                              │
│  Redis (optional)                                                            │
│  └─ Y.Doc binary updates persisted with 7-day TTL                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

The server is **structurally identical** to sheet's. We lift it.

---

## Source layout (target)

```
apps/web/src/
├── collab/                # lifted from ../sheet/apps/web/src/collab/
│   ├── bridge.ts          # Univer ↔ Yjs mutation translation — Y.Doc shape is slides-specific
│   ├── bridge-helpers.ts
│   ├── CollabDriver.tsx
│   ├── presence.ts        # cursor anchor model differs — elements, not cells
│   ├── PresenceLayer.tsx
│   ├── AvatarStack.tsx
│   ├── LiveEditGhost.tsx  # text-frame caret instead of cell editor
│   └── HistoryPanel.tsx
├── shell/                 # adapted from ../sheet/apps/web/src/shell/
│   ├── TitleBar.tsx
│   ├── Ribbon.tsx         # PowerPoint tabs replace Excel tabs
│   ├── SlidePanel.tsx     # NEW — left-rail thumbnail strip
│   ├── NotesPanel.tsx     # NEW — speaker notes editor
│   ├── StatusBar.tsx
│   ├── FileMenu.tsx
│   ├── CreateRoomDialog.tsx
│   ├── LoadingOverlay.tsx
│   └── ShareDialog.tsx
├── univer/
│   ├── setup.ts           # plugin registration (slides + slides-ui + docs + drawing)
│   ├── lazy.ts            # deferred-load fewer plugins than sheet
│   └── univerAPI.ts       # typed FUniver wrapper for slides
└── pptx/
    ├── worker.ts          # Web Worker entry point
    ├── pptx-import.ts     # JSZip + xml parser → ISlideData
    └── pptx-export.ts     # ISlideData → PptxGenJS → Blob
```

---

## Key data flows

### Open file (client-side)

1. User drops `.pptx` or uses File → Open.
2. File handed to the pptx Web Worker via `postMessage`.
3. Worker unzips, parses `presentation.xml`, slide layouts, masters, themes, and per-slide XML → `ISlideData`.
4. Main thread snapshot-installs the deck into Univer.
5. Resources (animations, transitions, comments) attach to Univer's `resources` plugin slot.

### Save / export (client-side)

1. Shell calls `FUniver.getActiveSlide().getSnapshot()` → `ISlideData`.
2. Passed to the pptx worker → PptxGenJS writes pptx → `Blob` returned.
3. Shell triggers a browser download.

### Co-editing — outgoing mutation

```
User drags a shape on slide-2
  → Univer fires slide.mutation.update-element
  → ICommandService.onMutationExecutedForCollab
  → bridge.ts: encode into Y.Doc update (coalesced per microtask via doc.transact)
  → y-websocket sends to server
  → server broadcasts to all peers in the room
```

> ⚠️ **Today** Univer Slides routes element edits through `CommandType.OPERATION`, not `MUTATION` — they don't fire the collab hook. Phase 0 Spike C decides whether to patch the fork (route mutations correctly) or wrap operations with our own mutation envelope. See [`UNIVER_SLIDES_GAPS.md`](./UNIVER_SLIDES_GAPS.md#collab-rev-tracking).

### Co-editing — incoming mutation

```
Server → y-websocket delivers Y.Doc update
  → bridge.ts: decode mutation(s)
  → rewriteUnitId + deepRewriteUnitId to match the local unit
  → cs.syncExecuteCommand(id, params, { fromCollab: true })
  → Univer applies; fromCollab flag prevents re-broadcast (echo-loop prevention)
```

### Joiner fast-path

Identical to sheet. `GET /api/rooms/:id/snapshot` returns gzip-streamed `ISlideData`; Yjs provider connects and applies any ops that arrived after the snapshot.

---

## Collab bridge — Yjs document shape

The Y.Doc mirrors `ISlideData` (defined in `../univer-revamp/packages/slides/src/types/interfaces/i-slide-data.ts:36`).

```
Y.Doc
├─ Y.Map "meta"           { id, title, locale, pageSize, appVersion }
├─ Y.Map "lists"          { [listId]: IListData }  // bullet/number list defs
├─ Y.Map "masters"        { [masterId]: ISlidePage }
├─ Y.Map "layouts"        { [layoutId]: ISlidePage }
├─ Y.Map "notesMaster"    { [id]: ISlidePage }
├─ Y.Map "handoutMaster"  { [id]: ISlidePage }
├─ Y.Map "pages"
│   └─ Y.Map [pageId]
│       ├─ Y.Map "meta"        { pageType, zIndex, title, description, background, colorScheme }
│       ├─ Y.Map "elements"    { [elementId]: IPageElement }
│       └─ Y.Map "properties"  { layoutObjectId, masterObjectId, isSkipped }
├─ Y.Array "pageOrder"
├─ Y.Map "resources"      { [pluginKey]: plugin-defined payload }
│   ├─ "CASUAL_SLIDES_ANIMATIONS"  → per-element animation timeline
│   ├─ "CASUAL_SLIDES_TRANSITIONS" → per-page transition
│   ├─ "CASUAL_SLIDES_COMMENTS"    → threaded comments anchored to elements
│   └─ "CASUAL_SLIDES_PPTX_RAW"    → opaque OOXML passthrough for round-trip
└─ Y.Map "theme"          { colorScheme, fontScheme }
```

Conflict semantics: **last-writer-wins on Y.Map leaves**. Acceptable for slides — same as PowerPoint's "last save wins" behavior on shared decks.

Open decision: cell-level rich-text in `IDocumentData` inside `richText.rich` — do we treat the doc tree as a single LWW blob (simple, lossy on concurrent typing into same text frame) or model it as Y.Text (correct, more code)? Sheet didn't have to solve this because cell text edits commit on blur. **Slides text frames don't commit on blur.** Default plan: Y.Text per text frame in P2. Spike before committing.

---

## Plugin loading strategy

Slides has fewer feature-plugins than sheet today. Bootstrap loads everything eagerly; revisit lazy-loading at P4 when we add tables, charts, animations.

| Plugin | Phase | Source |
| --- | --- | --- |
| `@univerjs/slides` | P0 | fork |
| `@univerjs/slides-ui` | P0 | fork |
| `@univerjs/docs` | P0 (required for richText elements) | fork |
| `@univerjs/docs-ui` | P0 | fork |
| `@univerjs/drawing` | P0 (required for image elements) | fork |
| `@univerjs/engine-render` | P0 | fork |
| `@univerjs/engine-formula` | P0 (loaded by docs, harmless) | fork |
| `@univerjs/ui` | P0 | fork |
| Comments plugin | P3 | TBD |
| Animations plugin | P4 | **ours**, registers `resources` slot |
| Tables plugin | P4 | **ours**, adds `TABLE` page-element type |

---

## Large-deck mitigations

| Problem | Solution |
| --- | --- |
| Main thread block on pptx parse | JSZip + xml parsing runs in a Web Worker |
| React state duplication of deck | Snapshot-as-ref — `ISlideData` lives only in Univer |
| Slow thumbnail render on 100-slide deck | Virtualized SlidePanel; render thumbs on intersection |
| Long-lived room memory growth | Stage-6 op-log compaction (port from sheet) |
| Embedded media bloat | Lazy-decode images; defer video element until in-viewport |

---

## Design decisions

| Decision | Rationale |
| --- | --- |
| Build on Univer Slides, not compose from primitives | Architectural symmetry with sheet; Univer's slide data model already matches Google Slides API and aligns with OOXML PresentationML structurally. See [`RESEARCH.md`](./RESEARCH.md). |
| Fork-first (`CasualOffice/univer-revamp`) wired via pnpm overrides | Slides needs patches from day 1 (collab rev, missing element types). Sheet's "fork is optional" approach won't work here. |
| Yjs over OT/ShareDB | Same reasoning as sheet — proven Hocuspocus adapter, awareness protocol, no central authority. |
| PptxGenJS for export | MIT, mature, generates real OOXML pptx. No alternative in OSS JS. |
| Custom pptx importer (JSZip + xml) | No equivalent of ExcelJS exists for pptx. We own this surface like we own xlsx for sheet. |
| No Univer Pro | Same as sheet. All charts, file I/O, history are built on OSS surface. |
| Lift sheet's server + admin + WOPI wholesale | They're structurally generic. Saves us a month of work. |
