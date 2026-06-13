import { Button, type ButtonRootProps } from '@heroui/react';
import type { ReactNode } from 'react';

export type YucpButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'discord';

export interface YucpButtonProps
  extends Omit<ButtonRootProps, 'variant' | 'ref' | 'children' | 'onPress'> {
  /** YUCP semantic variant */
  yucp?: YucpButtonVariant;
  /** If true, renders as pill (for standalone primary CTAs). Default: false (rounded rect for inline). */
  pill?: boolean;
  /** Shows a loading spinner and disables the button while true. */
  isLoading?: boolean;
  /** Semantic action callback. YUCP buttons do not forward the raw press event. */
  onPress?: () => void;
  children?: ReactNode;
}

const VARIANT_MAP: Record<YucpButtonVariant, NonNullable<ButtonRootProps['variant']>> = {
  primary: 'primary',
  secondary: 'secondary',
  danger: 'danger',
  ghost: 'ghost',
  discord: 'primary',
};

const LEGACY_CLASS_MAP: Record<YucpButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-ghost',
  danger: 'btn-danger',
  ghost: 'btn-ghost',
  discord: 'btn-discord',
};

const THEME_CLASS_MAP: Partial<Record<YucpButtonVariant, string>> = {
  primary:
    '!border-blue-800/30 !bg-blue-700 !text-slate-50 !shadow-lg hover:!bg-blue-800 data-[hovered=true]:!bg-blue-800 dark:!border-blue-200/20 dark:!bg-blue-600 dark:hover:!bg-blue-500 dark:data-[hovered=true]:!bg-blue-500 disabled:!border-blue-800/20 disabled:!bg-blue-700/55 disabled:!text-slate-50/92 dark:disabled:!border-blue-200/15 dark:disabled:!bg-blue-600/40 dark:disabled:!text-slate-50/85',
};

export function YucpButton({
  yucp = 'primary',
  pill = false,
  isLoading = false,
  onPress,
  className,
  children,
  isDisabled,
  ...props
}: YucpButtonProps) {
  const variant = VARIANT_MAP[yucp];
  const legacyClass = LEGACY_CLASS_MAP[yucp];
  const themeClass = THEME_CLASS_MAP[yucp] ?? '';
  const radiusClass = pill ? 'rounded-full' : 'rounded-[10px]';
  const content: ReactNode = isLoading ? (
    <>
      <span className="btn-loading-spinner" aria-hidden="true" />
      {children}
    </>
  ) : (
    children
  );

  const loadingClass = isLoading ? 'btn-loading' : '';

  return (
    <Button
      variant={variant}
      isDisabled={isDisabled || isLoading}
      className={[legacyClass, themeClass, radiusClass, loadingClass, className]
        .filter(Boolean)
        .join(' ')}
      onPress={onPress ? () => onPress() : undefined}
      {...props}
    >
      {content}
    </Button>
  );
}

YucpButton.displayName = 'YucpButton';
