import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import {
  ToastContext,
  type ToastContextValue,
  type ToastOptions,
  type ToastType,
} from '@/components/ui/toastContext';

export type { ToastAction, ToastOptions, ToastType } from '@/components/ui/toastContext';
export { useToast } from '@/components/ui/toastContext';

interface ToastItem {
  id: string;
  type: ToastType;
  title: string;
  description?: string;
  duration: number;
  action?: ToastOptions['action'];
  exiting: boolean;
}

let counter = 0;
function uniqueId() {
  return `toast-${++counter}`;
}

const DEFAULT_DURATION = 4000;
const MAX_VISIBLE = 3;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 300);
  }, []);

  const add = useCallback((type: ToastType, title: string, options?: ToastOptions): string => {
    const id = uniqueId();
    const duration = options?.duration ?? DEFAULT_DURATION;
    const item: ToastItem = {
      id,
      type,
      title,
      description: options?.description,
      action: options?.action,
      duration,
      exiting: false,
    };
    setToasts((prev) => {
      const next = [item, ...prev];
      return next.slice(0, MAX_VISIBLE);
    });
    return id;
  }, []);

  const value: ToastContextValue = {
    success: (title, opts) => add('success', title, opts),
    error: (title, opts) => add('error', title, opts),
    warning: (title, opts) => add('warning', title, opts),
    info: (title, opts) => add('info', title, opts),
    dismiss,
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastList toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastList({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <section className="toast-viewport" aria-label="Notifications" aria-live="polite">
      {toasts.map((toast) => (
        <ToastItemComponent key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </section>
  );
}

function ToastItemComponent({
  toast,
  onDismiss,
}: {
  toast: ToastItem;
  onDismiss: (id: string) => void;
}) {
  const [entering, setEntering] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntering(false));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (toast.duration <= 0) return;
    timerRef.current = setTimeout(() => {
      onDismiss(toast.id);
    }, toast.duration);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [toast.id, toast.duration, onDismiss]);

  const className = [
    'toast',
    `toast-${toast.type}`,
    toast.duration <= 0 ? 'toast-persistent' : '',
    entering ? 'toast-enter' : '',
    toast.exiting ? 'toast-exit' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const role = toast.type === 'error' ? 'alert' : 'status';
  const ariaLive = toast.type === 'error' ? 'assertive' : 'polite';

  return (
    <div className={className} role={role} aria-live={ariaLive}>
      <span className="toast-icon" aria-hidden="true">
        <ToastIcon type={toast.type} />
      </span>
      <div className="toast-content">
        <div className="toast-title">{toast.title}</div>
        {toast.description ? <div className="toast-description">{toast.description}</div> : null}
        {toast.action ? (
          <button
            type="button"
            className="toast-action"
            onClick={() => {
              toast.action?.onClick();
              onDismiss(toast.id);
            }}
          >
            {toast.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        className="toast-close"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
      >
        <Icon name="close" size={12} />
      </button>
      {toast.duration > 0 ? (
        <div
          className="toast-progress"
          style={{ animationDuration: `${toast.duration}ms` }}
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}

function ToastIcon({ type }: { type: ToastType }) {
  switch (type) {
    case 'success':
      return <Icon name="success" />;
    case 'error':
      return <Icon name="close" />;
    case 'warning':
      return <Icon name="alert" />;
    case 'info':
      return <Icon name="info" size={20} />;
    default:
      return null;
  }
}
