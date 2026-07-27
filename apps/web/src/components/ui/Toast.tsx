import { Toast as HeroUIToast, toast } from '@heroui/react';
import { type ReactNode, useMemo } from 'react';
import {
  ToastContext,
  type ToastContextValue,
  type ToastOptions,
  type ToastType,
} from '@/components/ui/toastContext';

export type { ToastAction, ToastOptions, ToastType } from '@/components/ui/toastContext';
export { useToast } from '@/components/ui/toastContext';

function showToast(type: ToastType, title: string, options?: ToastOptions): string {
  let toastId = '';
  const heroOptions = {
    description: options?.description,
    timeout: options?.duration,
    actionProps: options?.action
      ? {
          children: options.action.label,
          onPress: () => {
            options.action?.onClick();
            toast.close(toastId);
          },
        }
      : undefined,
  };

  switch (type) {
    case 'success':
      toastId = toast.success(title, heroOptions);
      break;
    case 'error':
      toastId = toast.danger(title, heroOptions);
      break;
    case 'warning':
      toastId = toast.warning(title, heroOptions);
      break;
    case 'info':
      toastId = toast.info(title, heroOptions);
      break;
  }

  return toastId;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const value = useMemo<ToastContextValue>(
    () => ({
      success: (title, options) => showToast('success', title, options),
      error: (title, options) => showToast('error', title, options),
      warning: (title, options) => showToast('warning', title, options),
      info: (title, options) => showToast('info', title, options),
      dismiss: (id) => toast.close(id),
    }),
    []
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <HeroUIToast.Provider maxVisibleToasts={3} placement="bottom" />
    </ToastContext.Provider>
  );
}
