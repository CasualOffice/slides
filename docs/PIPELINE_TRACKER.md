# Pipeline tracker

Single-user feature parity with Google Slides. Each row is independently
shippable. Multi-agent execution: each item below maps to one agent in a
git worktree, branched off `main`, pushed under its `branch` name.

Update this file when an item lands or shifts ownership.

## Sprint 1 — small parallel features

| # | Feature                          | Owner   | Branch                     | Status     | Notes |
|---|----------------------------------|---------|----------------------------|------------|-------|
| 1 | Properties dialog                | agent-A | `feat/properties-dialog`   | ⏳ pending | File → Properties menu item; modal with title / slide count / page size / created / modified |
| 2 | Slide-bar right-click menu       | agent-B | `feat/context-menu`        | ⏳ pending | Right-click on a thumbnail → New / Duplicate / Delete (dispatches existing slide commands) |
| 3 | Background color picker          | agent-C | `feat/bg-color-picker`     | ⏳ pending | Toolbar "Background" button → swatch grid → `slide.mutation.update-page` for active slide only |

## Sprint 2 — sequential (after sprint 1 merges)

| # | Feature                          | Owner | Status   | Notes |
|---|----------------------------------|-------|----------|-------|
| 4 | Selection-aware text formatting  | -     | planned  | Bold/Italic/Underline buttons active when a text frame is selected. Needs UX design (floating context bar vs sticky toolbar). |
| 5 | Image export round-trip          | -     | planned  | Embed image bytes into the pptx `/media/` folder + rels so saved decks keep images. |
| 6 | Recent files (IndexedDB)         | -     | planned  | Last 10 decks on landing; File menu submenu. |
| 7 | About dialog                     | -     | planned  | Help → About — version, repo, license, commits. |
| 8 | Slide layouts                    | -     | planned  | "New Slide" dropdown with 6 layout templates. |

## Sprint 3 — fidelity + depth

| # | Feature                          | Owner | Status   | Notes |
|---|----------------------------------|-------|----------|-------|
| 9  | Multi-run rich text (import)    | -     | planned  | Parse `<a:r>` runs into Univer's `IDocumentData`. Big fidelity win on real pptx. |
| 10 | Master / layout passthrough     | -     | planned  | Round-trip via `resources["CASUAL_SLIDES_PPTX_RAW"]`. |
| 11 | Find and replace                | -     | planned  | Modal + iterate all text elements. |
| 12 | Comments                        | -     | planned  | Anchor comments to slides via `resources` slot. |

## Sprint 4 — co-editing (after single-user parity)

Per user direction, P2 collab work resumes only after sprints 1–3 land.

| # | Feature                          | Owner | Status   | Notes |
|---|----------------------------------|-------|----------|-------|
| 13 | Yjs upgrade for CRDT correctness | -     | planned  | Replace raw-broadcast in apps/server with Y.Doc state vectors. Bridge stays. |
| 14 | Presence (cursors / avatars)     | -     | planned  | Use Awareness protocol from y-protocols. |
| 15 | Snapshot fast-path on join       | -     | planned  | Late joiners receive the current snapshot, not just deltas. |

## Conventions

- **Branch off `main`** at the time of agent dispatch.
- **No dependencies between sprint-1 items** — agents may all run in parallel.
- **One new component per item** under `apps/web/src/shell/`; touches to `App.tsx` / `Toolbar.tsx` / `styles.css` are unavoidable and resolved at merge time.
- **Commit messages** follow conventional commits (`feat(scope): subject`). No `Co-Authored-By: Claude` trailer (project rule).
- **Tests** — each item adds at least one Playwright assertion in `tests/e2e/smoke.spec.ts` and verifies `pnpm typecheck` + the smoke suite stays green.
