import { type ReactNode, useId } from 'react';

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
  children,
}: Readonly<{
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  footer?: ReactNode;
  children: ReactNode;
}>) {
  return (
    <section className={joinClasses('section-card account-surface-card', className)}>
      <div className="account-surface-card-header">
        <div className="account-surface-card-copy">
          {eyebrow ? <div className="account-surface-card-eyebrow">{eyebrow}</div> : null}
          <h3 className="account-surface-card-title">{title}</h3>
          {description ? <p className="account-surface-card-desc">{description}</p> : null}
        </div>
        {actions ? <div className="account-surface-card-actions">{actions}</div> : null}
      </div>

      <div className={joinClasses('account-surface-card-body', bodyClassName)}>{children}</div>

      {footer ? <div className="account-surface-card-footer">{footer}</div> : null}
    </section>
  );
}

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
  return <p className="account-inline-error">{message}</p>;
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

  return (
    <div className="account-modal-backdrop" role="presentation">
      <button
        type="button"
        className="account-modal-scrim"
        aria-label={closeLabel}
        onClick={onClose}
      />
      <div className="account-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h3 id={titleId} className="account-modal-title">
          {title}
        </h3>
        {children}
      </div>
    </div>
  );
}
