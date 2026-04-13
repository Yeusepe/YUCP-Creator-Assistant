import { Input, type InputRootProps } from '@heroui/react';
import type { ChangeEvent, RefObject } from 'react';

export interface YucpInputProps extends Omit<InputRootProps, 'ref' | 'onChange'> {
  /** Optional ref forwarded to the underlying input element. */
  inputRef?: RefObject<HTMLInputElement | null>;
  /** When true, renders input text in a monospace font (useful for codes/keys). */
  mono?: boolean;
  /** HeroUI-style value change handler (receives string value directly). */
  onValueChange?: (value: string) => void;
  /** Mirror of HTML disabled, preferred alias for consistency with HeroUI Button. */
  isDisabled?: boolean;
}

/**
 * YucpInput, HeroUI Input wrapper that applies our glass-morphism design tokens.
 *
 * API note: HeroUI v3 Input extends react-aria-components Input, which uses
 * standard HTML attributes (onChange, disabled). This wrapper adds:
 *   - `onValueChange` convenience prop (receives string directly)
 *   - `isDisabled` alias for `disabled`
 *   - `mono` for monospace font (license keys, confirmation codes)
 *   - `inputRef` for forwarded refs
 *
 * Usage:
 *   <YucpInput placeholder="Enter key" value={key} onValueChange={setKey} />
 *   <YucpInput mono placeholder="DELETE" value={val} onValueChange={setVal} />
 */
export function YucpInput({
  inputRef,
  mono = false,
  onValueChange,
  isDisabled,
  className,
  ...props
}: YucpInputProps) {
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    onValueChange?.(event.target.value);
  }

  return (
    <Input
      ref={inputRef}
      variant="secondary"
      disabled={isDisabled}
      onChange={onValueChange ? handleChange : undefined}
      className={[mono ? 'font-mono' : '', className].filter(Boolean).join(' ') || undefined}
      {...props}
    />
  );
}

YucpInput.displayName = 'YucpInput';
