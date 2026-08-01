import { buttonVariants, Spinner } from '@heroui/react';
import { PressableFeedback } from '@heroui-pro/react/pressable-feedback';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

const DEFAULT_HOLD_DURATION_MS = 1200;
// PressableFeedback applies `border-radius: inherit` after HeroUI's `.button` rule.
// Reapply HeroUI's default radius as a utility so the composed control keeps its button shape.
const HEROUI_BUTTON_RADIUS_CLASS = 'rounded-3xl';

export interface DestructiveActionButtonProps
  extends Omit<ComponentPropsWithoutRef<'button'>, 'children' | 'disabled' | 'onClick'> {
  children: ReactNode;
  holdDuration?: number;
  isDisabled?: boolean;
  isPending?: boolean;
  onConfirm: () => void;
  pendingLabel?: string;
  size?: 'sm' | 'md' | 'lg';
}

function getAccessibleLabel(children: ReactNode, pendingLabel: string, isPending: boolean) {
  if (isPending) {
    return pendingLabel;
  }

  return typeof children === 'string' ? `Hold to ${children.toLowerCase()}` : 'Hold to confirm';
}

/**
 * A single-button destructive action using HeroUI Pro's hold-confirm interaction.
 * Reference: https://heroui.pro/docs/react/components/pressable-feedback#hold-confirm-callback
 */
export function DestructiveActionButton({
  children,
  className,
  holdDuration = DEFAULT_HOLD_DURATION_MS,
  isDisabled = false,
  isPending = false,
  onConfirm,
  pendingLabel = 'Working...',
  size = 'md',
  ...props
}: DestructiveActionButtonProps) {
  const disabled = isDisabled || isPending;
  const accessibleLabel =
    props['aria-label'] ?? getAccessibleLabel(children, pendingLabel, isPending);

  return (
    <PressableFeedback
      {...props}
      aria-label={accessibleLabel}
      className={buttonVariants({
        className: [`${HEROUI_BUTTON_RADIUS_CLASS} justify-center shadow-none`, className]
          .filter(Boolean)
          .join(' '),
        size,
        variant: 'danger-soft',
      })}
      isDisabled={disabled}
    >
      <span className="relative z-10 inline-flex items-center justify-center gap-2">
        {isPending ? <Spinner color="current" size="sm" aria-hidden="true" /> : null}
        {isPending ? pendingLabel : children}
      </span>
      {!isPending ? (
        <PressableFeedback.HoldConfirm
          className="bg-danger text-danger-foreground"
          duration={holdDuration}
          isDisabled={disabled}
          onComplete={onConfirm}
        >
          <span className="inline-flex items-center justify-center gap-2">{children}</span>
        </PressableFeedback.HoldConfirm>
      ) : null}
    </PressableFeedback>
  );
}

DestructiveActionButton.displayName = 'DestructiveActionButton';
