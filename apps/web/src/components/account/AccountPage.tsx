import { type ReactNode, useEffect, useId, useRef } from 'react';

function joinClasses(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

export function AccountPage({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <div className="dashboard-tab-panel is-active account-dashboard-view">
      <div className="bento-grid account-bento-grid">{children}</div>
    </div>
  );
}

export function AccountSectionCard({
  eyebrow,
  title,
  description,
  actions,
  className,
  bodyClassName,
  footer,
  leading,
  children,
}: Readonly<{
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  footer?: ReactNode;
  /** Optional icon or illustration shown beside the title block */
  leading?: ReactNode;
  children: ReactNode;
}>) {
  return (
    <section className={joinClasses('section-card account-surface-card', className)}>
      <div className="account-surface-card-header">
        <div className="account-surface-card-header-cluster">
          {leading ? <div className="account-surface-card-leading">{leading}</div> : null}
          <div className="account-surface-card-copy">
            {eyebrow ? <div className="account-surface-card-eyebrow">{eyebrow}</div> : null}
            <h3 className="account-surface-card-title">{title}</h3>
            {description ? <p className="account-surface-card-desc">{description}</p> : null}
          </div>
        </div>
        {actions ? <div className="account-surface-card-actions">{actions}</div> : null}
      </div>

      <div className={joinClasses('account-surface-card-body', bodyClassName)}>{children}</div>

      {footer ? <div className="account-surface-card-footer">{footer}</div> : null}
    </section>
  );
}

/** Alias for {@link AccountSectionCard} — the same security-page glass section pattern for any route. */
export { AccountSectionCard as WorkspaceSectionCard };

export function AccountEmptyState({
  icon,
  title,
  description,
  action,
}: Readonly<{
  icon: ReactNode;
  title: string;
  description: ReactNode;
  action?: ReactNode;
}>) {
  return (
    <div className="account-empty">
      <div className="account-empty-icon" aria-hidden="true">
        {icon}
      </div>
      <p className="account-empty-title">{title}</p>
      <div className="empty-state-copy">{description}</div>
      {action ? <div className="account-empty-action">{action}</div> : null}
    </div>
  );
}

export function AccountInlineError({ message }: Readonly<{ message: string }>) {
  return (
    <p className="account-inline-error" role="alert">
      {message}
    </p>
  );
}

export function AccountModal({
  title,
  onClose,
  closeLabel = 'Close dialog',
  children,
}: Readonly<{
  title: string;
  onClose: () => void;
  closeLabel?: string;
  children: ReactNode;
}>) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusable = dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    (focusable[0] ?? dialog).focus();

    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }

    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('keydown', handleEscape);
      previousFocusRef.current?.focus();
    };
  }, [onClose]);

  // Focus trap: keep keyboard focus within the dialog while open
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog == null) return;
    const safeDialog: HTMLElement = dialog;

    const FOCUSABLE =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    function handleTab(e: KeyboardEvent) {
      if (e.key !== 'Tab') return;
      const focusable = Array.from(safeDialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) {
        e.preventDefault();
        safeDialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;

      if (!safeDialog.contains(activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (!e.shiftKey && (activeElement === safeDialog || activeElement === last)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (activeElement === safeDialog || activeElement === first)) {
        e.preventDefault();
        last.focus();
      }
    }

    safeDialog.addEventListener('keydown', handleTab);
    return () => safeDialog.removeEventListener('keydown', handleTab);
  }, []);

  return (
    <div className="account-modal-backdrop" role="presentation">
      <button
        type="button"
        className="account-modal-scrim"
        aria-label={closeLabel}
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        className="account-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h3 id={titleId} className="account-modal-title">
          {title}
        </h3>
        {children}
      </div>
    </div>
  );
}
