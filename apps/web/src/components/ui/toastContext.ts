import { type Context, createContext, useContext } from 'react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  /** How long to show the toast in ms. Defaults to 4000. Pass 0 for no auto-dismiss. */
  duration?: number;
  /** Optional description line below the title. */
  description?: string;
  /** Optional action button rendered inside the toast. */
  action?: ToastAction;
}

export interface ToastContextValue {
  success(title: string, options?: ToastOptions): string;
  error(title: string, options?: ToastOptions): string;
  warning(title: string, options?: ToastOptions): string;
  info(title: string, options?: ToastOptions): string;
  dismiss(id: string): void;
}

interface ToastHotData {
  toastContext?: Context<ToastContextValue | null>;
}

const hotData = import.meta.hot?.data as ToastHotData | undefined;

/*
 * Preserve the context object across Vite updates. Without this, a lazy route
 * can retain the previous module while the document receives the new provider,
 * leaving useToast connected to a different context instance.
 */
export const ToastContext = hotData?.toastContext ?? createContext<ToastContextValue | null>(null);

if (import.meta.hot) {
  import.meta.hot.data.toastContext = ToastContext;
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used inside <ToastProvider>');
  }
  return context;
}
