# Casual Slides

Web-based PowerPoint-equivalent with real-time co-editing. Built on [Univer OSS](https://github.com/dream-num/univer) (Apache-2.0). Sister product to [Casual Sheets](https://github.com/schnsrw/sheets).

```
upload .pptx → open in browser → multi-user co-edit → download .pptx
```

## Status

P0 — Spikes. See [PLAN.md](./PLAN.md).

## Stack

| Concern | Pick |
| --- | --- |
| Slide engine | Univer Slides (forked at [`schnsrw/univer-revamp`](https://github.com/schnsrw/univer-revamp), patched via `pnpm patch`) |
| Frontend | React 18 + Vite + TypeScript strict |
| Collab | Yjs + Hocuspocus over WebSocket |
| pptx export | PptxGenJS (MIT) |
| pptx import | JSZip + fast-xml-parser → `ISlideData` (custom) |

## Docs

- [`CLAUDE.md`](./CLAUDE.md) — repo instructions
- [`PLAN.md`](./PLAN.md) — phased plan (P0–P6)
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — system design
- [`docs/RESEARCH.md`](./docs/RESEARCH.md) — Univer Slides technical brief
- [`docs/UNIVER_SLIDES_GAPS.md`](./docs/UNIVER_SLIDES_GAPS.md) — fork-patch plan
- [`docs/PPTX_PIPELINE.md`](./docs/PPTX_PIPELINE.md) — pptx I/O pipeline

## Dev

```
pnpm install
pnpm dev:web        # http://127.0.0.1:5373/
pnpm typecheck
```

## License

Apache-2.0.
