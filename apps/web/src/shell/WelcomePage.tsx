export interface WelcomePageProps {
  onNew: () => void;
  onOpen: () => void;
  onOpenRecent: () => void;
  opening?: boolean;
  error?: string | null;
}

export function WelcomePage({ onNew, onOpen, onOpenRecent, opening = false, error }: WelcomePageProps) {
  return (
    <main className="cs-welcome" aria-labelledby="welcome-title">
      <div className="cs-welcome__content">
        <p className="cs-welcome__brand">Casual Slides</p>
        <h1 id="welcome-title">Welcome</h1>
        <div className="cs-welcome__actions">
          <button type="button" className="cs-welcome__card" onClick={onNew} aria-label="New presentation" disabled={opening}>
            <strong>New presentation</strong>
            <span>Start with a blank deck</span>
          </button>
          <button type="button" className="cs-welcome__card" onClick={onOpen} aria-label="Open presentation" disabled={opening}>
            <strong>Open presentation</strong>
            <span>Choose a .pptx file</span>
          </button>
          <button type="button" className="cs-welcome__card" onClick={onOpenRecent} aria-label="Recent presentations" disabled={opening}>
            <strong>Recent presentations</strong>
            <span>Continue where you left off</span>
          </button>
        </div>
        {opening && <p className="cs-welcome__feedback" role="status">Opening presentation…</p>}
        {error && <p className="cs-welcome__feedback cs-welcome__feedback--error" role="alert">{error}</p>}
      </div>
    </main>
  );
}
