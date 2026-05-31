import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

// Root error boundary — catches any throw from below the React mount and
// shows a branded recovery card instead of a blank white screen. The
// canvas state is unrecoverable past this point (Univer's render engine
// holds the snapshot), so the only sane action is a hard reload. We
// surface the error message + collapsible stack so a user can copy it
// into a bug report.
//
// Class component because componentDidCatch / getDerivedStateFromError
// are only available on class components. The fallback render itself is
// extracted to a function component so it can use hooks for i18n.

interface State {
  error: Error | null;
  details: ErrorInfo | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, details: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, details: null };
  }

  componentDidCatch(error: Error, details: ErrorInfo): void {
    this.setState({ error, details });
    // Mirror to console so the dev tools / hosting platform's error
    // tracker can still pick it up. Once a telemetry sink (Sentry,
    // Datadog) is wired, the post should go there too.
    // eslint-disable-next-line no-console
    console.error('[Casual Slides] uncaught render error', error, details);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <ErrorFallback
          error={this.state.error}
          details={this.state.details}
        />
      );
    }
    return this.props.children;
  }
}

function ErrorFallback({ error, details }: { error: Error; details: ErrorInfo | null }) {
  const { t } = useTranslation('errors');
  return (
    <div className="cs-error-boundary" role="alert" aria-live="assertive">
      <div className="cs-error-boundary__card">
        <img
          src={`${import.meta.env.BASE_URL}brand.svg`}
          alt=""
          width={44}
          height={55}
          className="cs-error-boundary__logo"
        />
        <h1 className="cs-error-boundary__title">{t('boundary.title')}</h1>
        <p className="cs-error-boundary__lede">{t('boundary.lede')}</p>
        <div className="cs-error-boundary__actions">
          <button
            type="button"
            className="cs-btn cs-btn--accent"
            onClick={() => window.location.reload()}
          >
            {t('boundary.reload')}
          </button>
        </div>
        <details className="cs-error-boundary__details">
          <summary>{t('boundary.detailsLabel')}</summary>
          <pre className="cs-error-boundary__stack">
{error.message}
{error.stack ? `\n\n${error.stack}` : ''}
{details?.componentStack ? `\n\nComponent stack:${details.componentStack}` : ''}
          </pre>
        </details>
      </div>
    </div>
  );
}
