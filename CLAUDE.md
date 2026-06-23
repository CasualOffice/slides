# CLAUDE.md — instructions for Claude Code in this repo

## What this project is

A web-based **PowerPoint-equivalent** with real-time collaborative editing, built on **Univer OSS** (Apache-2.0). The goal UX is Microsoft PowerPoint / Office — ribbon, slide panel, file-centric flow — not Google Slides.

Sister product to [`/services/sheet`](../sheet/) (Casual Sheets) and [`/services/document`](../document/) (docx editor). Shares the self-host platform (WOPI · JWT · admin · webhooks) and the collab bridge architecture.

## What's in scope

- Upload `.pptx` → open in browser session → multi-user co-edit → download `.pptx`.
- In-memory sessions only. No database. No accounts in v0.0.x.
- Office-style UI shell built on top of Univer's slide canvas.
- Self-host story in v0.1 — same WOPI · JWT · admin · webhooks stack as sheet.

## What's out of scope (do not propose, do not build)

- **Univer Pro features** — collab, file I/O, history are all paid in Univer's commercial offering. We build them ourselves on OSS.
- **AI / LLM features** — plug in via Univer's command bus later.
- **Auth / sharing UI / permissions model** — anonymous sessions by room URL in v0.0.x; JWT in v0.1.
- **Pixel-perfect PowerPoint clone** — "clearly familiar to Office users" is the bar.
- **100% pptx fidelity** — same lesson as xlsx. Pick the 80% that matters.

## Required reading before substantive work

1. [`PLAN.md`](./PLAN.md) — phased plan.
2. [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — how the pieces fit.
3. [`docs/RESEARCH.md`](./docs/RESEARCH.md) — Univer Slides technical brief.
4. [`docs/UNIVER_SLIDES_GAPS.md`](./docs/UNIVER_SLIDES_GAPS.md) — what's missing in `@univerjs/slides` and how we patch it.
5. [`docs/PPTX_PIPELINE.md`](./docs/PPTX_PIPELINE.md) — pptx I/O strategy.

## Hard rules

### Reuse sheet patterns — don't re-derive

The sheet repo at `../sheet/` has already solved: collab bridge, host.Integration, admin panel, JWT auth, webhooks, WOPI endpoints, Docker shell, Office shell skeleton, theme bridge, autosave, recent files. **Copy patterns wholesale.** Don't invent new shapes for problems we've already solved.

Cite sheet code with `../sheet/apps/web/src/.../file.ts:LINE` when explaining a transferred pattern.

### Fork-and-patch for the Univer layer

Slides has gaps Univer hasn't filled (no collab rev tracking on `SlideDataModel`; element ops typed as `OPERATION` instead of `MUTATION`; no table/chart/line/video as `IPageElement`). All upstream-eligible.

**Workflow:** land the change in the fork (`../univer-revamp/` on `dev`), open an upstream PR to `dream-num/univer`, mirror the same diff as a `pnpm patch` artifact in [`patches/`](./patches/) so production builds get the fix without waiting for an upstream release. See [`docs/UNIVER_SLIDES_GAPS.md`](./docs/UNIVER_SLIDES_GAPS.md#fork-management-strategy).

Fork location: `../univer-revamp/` at **v0.24.0** (synced with sheet's vendored copy as of 2026-05-25). Commits land in `CasualOffice/univer-revamp` on `dev`.

We tried `pnpm overrides: link:` to the fork; it doesn't work — the fork's packages use `workspace:*` deps that can't resolve across workspaces. Sheet's `patchedDependencies` pattern is what we use.

### Pin Univer version

Same rule as sheet — pick one version, pin all `@univerjs/*` packages exactly. Mixed minor versions break plugin contracts. Target **v0.24.0** to match sheet (re-evaluate when sheet bumps).

### Use the collab hook Univer designed

`ICommandService.onMutationExecutedForCollab` (sheet/vendor/univer/packages/core/src/services/command/command.service.ts:404). Same hook as sheet. The catch: Univer Slides currently does **not** treat element mutations as `CommandType.MUTATION` for collab — they go through `CommandType.OPERATION`. Part of the fork-patch work (see `UNIVER_SLIDES_GAPS.md`).

### License hygiene

**Apache-2.0 or MIT only.** No AGPL, no source-available. This ruled out PPTist; it rules out tldraw SDK for production. Verify license before adding any dependency.

## Stack conventions

- TypeScript strict everywhere.
- React 18 + Vite for the frontend.
- Hocuspocus + Yjs for the collab server. Same shape as sheet's stand-alone Node service.
- **PptxGenJS** (MIT) for pptx export.
- **JSZip + fast-xml-parser** for pptx import (custom OOXML PresentationML → `ISlideData` mapper). See [`docs/PPTX_PIPELINE.md`](./docs/PPTX_PIPELINE.md).
- Tailwind, matching sheet — confirm before Phase 1.
- Fluent UI icons to match Office look.

## Phase awareness

Always know which phase before writing code:

- **Phase 0** (current) — spikes only. Throwaway code that proves one risk.
- **Phase 1** — single-user editor + Office shell.
- **Phase 2** — Yjs collab.
- **Phase 3** — presence.
- **Phase 4+** — see PLAN.md.

Don't start Phase 1 code until Phase 0 spikes are decided.

## Style

- Tight, decision-oriented. Match `../sheet/PLAN.md` and `../sheet/docs/*`.
- No marketing language. State decisions and tradeoffs.
- When citing Univer source: `../univer-revamp/packages/.../file.ts:LINE`.
- When citing sheet code: `../sheet/apps/.../file.ts:LINE`.
