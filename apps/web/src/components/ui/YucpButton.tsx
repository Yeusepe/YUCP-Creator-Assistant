import { Button, type ButtonRootProps, Spinner } from '@heroui/react';
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
  danger: 'danger-soft',
  ghost: 'ghost',
  discord: 'primary',
};

const SPECIAL_CLASS_MAP: Partial<Record<YucpButtonVariant, string>> = {
  discord: 'btn-discord',
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
  const specialClass = SPECIAL_CLASS_MAP[yucp] ?? '';
  const radiusClass = pill ? 'rounded-full' : '';
  const content: ReactNode = isLoading ? (
    <>
      <Spinner color="current" size="sm" aria-hidden="true" />
      {children}
    </>
  ) : (
    children
  );

  return (
    <Button
      variant={variant}
      isDisabled={isDisabled || isLoading}
      isPending={isLoading}
      className={[specialClass, radiusClass, className].filter(Boolean).join(' ')}
      onPress={onPress ? () => onPress() : undefined}
      {...props}
    >
      {content}
    </Button>
  );
}

YucpButton.displayName = 'YucpButton';
