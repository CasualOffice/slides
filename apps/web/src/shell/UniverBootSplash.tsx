// Workspace-area splash painted over the (briefly blank) Univer canvas
// during plugin boot. App.tsx owns the `visible` flag — flipped false
// ~120 ms after Univer's SlideDataModel becomes reachable, or by an
// 8 s safety net if the engine hangs. Distinct from BusyOverlay: that
// one represents an in-flight Open/Save operation; this one is the
// first-paint welcoming state.

export interface UniverBootSplashProps {
  visible: boolean;
}

export function UniverBootSplash({ visible }: UniverBootSplashProps) {
  const { t } = useTranslation('chrome');
  if (!visible) return null;
  return (
    <div
      className="cs-workspace__boot-splash"
      role="status"
      aria-live="polite"
      data-testid="boot-splash"
    >
      <img
        src="/assets/ppt-editor/brand.svg"
        alt=""
        width={44}
        height={55}
        className="cs-workspace__boot-splash-logo"
      />
      <div className="cs-spinner cs-spinner--sm" aria-hidden="true" />
      <span className="cs-workspace__boot-splash-text">
        {t('workspace.bootSplash')}
      </span>
    </div>
  );
}
import { useTranslation } from '../i18n';
