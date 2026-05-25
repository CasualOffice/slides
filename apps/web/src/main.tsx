import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Univer manages its own internal React root inside the container we hand it.
// React.StrictMode's double-invocation of effects in dev unmounts/remounts the
// Univer instance before its first render completes, which leaves the DOM in
// an inconsistent state. Same pattern most editor SDKs (Monaco, Univer, Lexical)
// require. Do NOT wrap App in StrictMode at this boundary.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
