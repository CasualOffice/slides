import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ShortcutsProvider } from './shell/ShortcutsDialog';
import { FormatPaneProvider } from './shell/FormatPane';
// i18n must initialise before any React component mounts so the first
// render of <App /> already sees the configured `t()` instance — otherwise
// components would fall back to raw keys for one tick.
import './i18n';
import './univer-styles';
import './styles.css';

// Warm the pptx Web Worker on idle so the first Save/Open click doesn't pay
// the ~1.9 MB worker bundle's cold-start cost. The client lazily instantiates
// the worker on first call — kicking it here means the worker is already
// resolved + ready when the user clicks. Without this, the first Save in CI
// timed out the Playwright download event (15 s) on slower runners.
import { getPptxClient } from './pptx/client';
const warmPptxClient = () => {
  // Resolving the singleton imports client.ts which imports types.ts which
  // pulls in the worker URL — Vite/Rollup hoists the worker chunk into the
  // initial graph and starts streaming it. Cheap, side-effect free.
  void getPptxClient();
};
if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
  (window as Window & { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback(warmPptxClient);
} else {
  setTimeout(warmPptxClient, 200);
}

// Univer manages its own internal React root inside the container we hand it.
// React.StrictMode's double-invocation of effects in dev unmounts/remounts the
// Univer instance before its first render completes, which leaves the DOM in
// an inconsistent state. Same pattern most editor SDKs (Monaco, Univer, Lexical)
// require. Do NOT wrap App in StrictMode at this boundary.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <>
    <App />
    <ShortcutsProvider />
    <FormatPaneProvider />
  </>,
);
