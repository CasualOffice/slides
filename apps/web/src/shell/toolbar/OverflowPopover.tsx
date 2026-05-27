// "More" overflow popover. Catches the format-control groups that don't fit
// on the current toolbar width. Renders inside a portal-ish fixed container
// (sibling of the toolbar, not a child) so the popover can extend past the
// toolbar's own height/clip region.
import { useRef } from 'react';
import { useTranslation } from '../../i18n';
import { anchorPosition, useDismiss } from './popover-utils';

export interface OverflowPopoverProps {
  anchor: DOMRect | null;
  onClose: () => void;
  children: React.ReactNode;
}

export function OverflowPopover({ anchor, onClose, children }: OverflowPopoverProps) {
  const { t } = useTranslation();
  const popoverRef = useRef<HTMLDivElement>(null);
  useDismiss(!!anchor, popoverRef, onClose);
  const pos = anchorPosition(anchor, 380, 240);
  if (!pos) return null;
  return (
    <div
      ref={popoverRef}
      className="cs-toolbar2__popover cs-toolbar2__popover--overflow"
      role="dialog"
      aria-label={t('toolbar.moreActions')}
      style={{ top: pos.top, left: pos.left }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="cs-toolbar2__overflow-row">{children}</div>
    </div>
  );
}
