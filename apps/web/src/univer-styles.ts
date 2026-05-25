// Univer ships its Tailwind-prefixed UI CSS as a per-package side-effect
// import. Without this, every `univer-flex`/`univer-h-full`/`univer-min-h-0`
// class on the rendered DOM has no rules, the workbench layout collapses
// to height: 0, the render-engine canvases get width=W height=0, and the
// editor paints nothing — the symptom is a black canvas with the slide-bar
// thumbnails visible (the SlideBar uses different CSS that survives).
//
// Diagnostic that caught this: tests/e2e/__diagnostic__/live-screenshot.spec.ts
// against the deployed URL — DOM was correct, canvases had height 0, classes
// were present but unresolved.

import '@univerjs/design/lib/index.css';
import '@univerjs/ui/lib/index.css';
import '@univerjs/docs-ui/lib/index.css';
import '@univerjs/slides-ui/lib/index.css';
