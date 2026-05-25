# Pipeline tracker

Single-user feature parity with Google Slides. Each row is independently
shippable. Multi-agent execution: each item below maps to one agent in a
git worktree, branched off `main`, pushed under its `branch` name.

Update this file when an item lands or shifts ownership.

## Sprint 1 — small parallel features

| # | Feature                          | Owner   | Branch                     | Status     | Notes |
|---|----------------------------------|---------|----------------------------|------------|-------|
| 1 | Properties dialog                | main    | `main`                     | ✅ landed   | **Feature**. File → Properties → modal with title / slide count / page size / element count / text length / format. Esc + click-outside close. |
| 2 | Slide-bar right-click menu       | -       | -                          | ⏳ pending  | **Feature**. Parallel-agent run blocked by org usage limit. Picking up sequentially next turn. |
| 3 | Image export round-trip          | -       | -                          | ⏳ pending  | **Fidelity**. Parallel-agent run blocked by org usage limit. Picking up sequentially next turn. |

Parallel agent dispatch hit the org's monthly usage limit (3 spawned, 0 progress). Sprint 1 is being completed sequentially on `main`.

Each sprint balances feature + fidelity work — we are an editor as well as a pptx reader; parity on both axes.

## Sprint 2 — sequential (after sprint 1 merges)

| # | Feature                          | Owner | Status   | Notes |
|---|----------------------------------|-------|----------|-------|
| 4 | Background color picker          | -     | planned  | Feature. Toolbar "Background" button → swatch grid → update-page for active slide. |
| 5 | Selection-aware text formatting  | -     | planned  | Feature. Bold/Italic/Underline buttons active when a text frame is selected. Needs UX design (floating context bar vs sticky toolbar). |
| 6 | Multi-run rich text (import)     | -     | planned  | Fidelity. Parse `<a:r>` runs into Univer's `IDocumentData`. Big win on real pptx. |
| 7 | Recent files (IndexedDB)         | -     | planned  | Feature. Last 10 decks on landing; File menu submenu. |
| 8 | About dialog                     | -     | planned  | Feature. Help → About — version, repo, license. |
| 9 | Slide layouts                    | -     | planned  | Feature. "New Slide" dropdown with 6 layout templates. |

## Sprint 3 — fidelity + depth

| # | Feature                          | Owner | Status   | Notes |
|---|----------------------------------|-------|----------|-------|
| 10 | Master / layout passthrough     | -     | planned  | Fidelity. Round-trip via `resources["CASUAL_SLIDES_PPTX_RAW"]`. |
| 11 | Theme colors / fonts round-trip | -     | planned  | Fidelity. Map `<a:clrScheme>` and `<a:fontScheme>` from `ppt/theme/theme1.xml`. |
| 12 | Find and replace                | -     | planned  | Feature. Modal + iterate all text elements. |
| 13 | Comments                        | -     | planned  | Feature. Anchor comments to slides via `resources` slot. |

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
