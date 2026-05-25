# Patches

`pnpm patch` artifacts applied to npm-installed dependencies — most importantly the `@univerjs/*` line.

## How patches enter this directory

```
pnpm patch @univerjs/slides@0.24.0          # opens an editable copy
# edit the files…
pnpm patch-commit /path/to/editable/copy    # writes patches/@univerjs__slides@0.24.0.patch
                                            # and registers it in package.json
                                            # pnpm.patchedDependencies
```

After a `pnpm install`, the patched version is the one in `node_modules`.

## Authoring large patches

For multi-file refactors (e.g. [Gap 2 — route slide element mutations through
`CommandType.MUTATION`](../docs/UNIVER_SLIDES_GAPS.md#gap-2--element-operations-declared-as-operation-not-mutation)):

1. Develop in the fork at `../univer-revamp/`, push a branch, open an upstream PR to `dream-num/univer`.
2. While the upstream PR is in review, mirror the diff here as a pnpm patch so production builds get the fix without waiting for an upstream release.
3. When the upstream change ships in a Univer release, bump the pinned `@univerjs/*` version and drop the patch.

## File naming

`pnpm patch-commit` writes `@univerjs__<pkg>@<version>.patch` automatically. Don't rename — the slug must match the `patchedDependencies` key in [`../package.json`](../package.json).
