// Univer ships its Tailwind-prefixed UI CSS as a per-package side-effect import.
// Without it, every `univer-flex`/`univer-h-full`/`univer-min-h-0` class has no
// rules, the workbench layout collapses to height:0, the render-engine canvases
// get height 0, and the editor paints nothing (black canvas, slide-bar visible).
//
// Consuming the engine from the submodule SOURCE (not built npm packages), the
// CSS lives at each package's `src/global.css` (reachable as the `./global.css`
// subpath). `@univerjs/design/global.css` carries the @tailwind directives that
// the product's PostCSS/Tailwind compiles (see postcss.config.mjs +
// tailwind.config.ts); the rest are component styles.
//
// Diagnostic that caught the original black-canvas issue:
// tests/e2e/__diagnostic__/live-screenshot.spec.ts.

import '@univerjs/design/global.css';
import '@univerjs/ui/global.css';
import '@univerjs/docs-ui/global.css';
import '@univerjs/slides-ui/global.css';
