import { PressableFeedback } from '@heroui-pro/react/pressable-feedback';
import type { ReactNode } from 'react';

export interface HoldConfirmButtonProps {
  accessibleLabel: string;
  children: ReactNode;
  confirmLabel?: ReactNode;
  duration?: number;
  isDisabled?: boolean;
  isPending?: boolean;
  onConfirm: () => void;
  pendingLabel?: ReactNode;
}

export function HoldConfirmButton({
  accessibleLabel,
  children,
  confirmLabel = 'Keep holding...',
  duration = 1200,
  isDisabled = false,
  isPending = false,
  onConfirm,
  pendingLabel = 'Working...',
}: HoldConfirmButtonProps) {
  return (
    <PressableFeedback
      type="button"
      aria-label={accessibleLabel}
      isDisabled={isDisabled || isPending}
      className="relative inline-flex min-h-8 min-w-28 items-center justify-center overflow-hidden rounded-xl border border-danger/20 bg-danger-soft px-3 text-xs font-semibold text-danger shadow-none outline-none transition-[transform,border-color] focus-visible:ring-2 focus-visible:ring-focus dark:border-danger/30 dark:bg-danger-soft dark:text-danger"
    >
      <span className="relative z-10 inline-flex items-center gap-1.5">
        {isPending ? <span className="btn-loading-spinner" aria-hidden="true" /> : null}
        {isPending ? pendingLabel : children}
      </span>
      <PressableFeedback.HoldConfirm
        duration={duration}
        isDisabled={isDisabled || isPending}
        onComplete={onConfirm}
        className="flex items-center justify-center bg-danger px-3 text-xs font-semibold text-danger-foreground dark:bg-danger dark:text-danger-foreground"
      >
        <span className="inline-flex items-center gap-1.5">{confirmLabel}</span>
      </PressableFeedback.HoldConfirm>
    </PressableFeedback>
  );
}
