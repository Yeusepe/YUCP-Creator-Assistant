import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from 'react';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  id?: string;
  value: string;
  options: ReadonlyArray<SelectOption>;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

export function Select({ id, value, options, onChange, disabled, className }: SelectProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const generatedId = useId();

  const selectedOption = options.find((o) => o.value === value) ?? null;
  const listboxId = `${id ?? generatedId}-listbox`;

  const close = useCallback(() => setOpen(false), []);

  const toggle = useCallback(() => {
    if (!disabled) setOpen((prev) => !prev);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        close();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, close]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>) => {
      if (disabled) return;
      if (e.key === 'Escape') {
        close();
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        if (!open) setOpen(true);
        return;
      }
      if (!open) return;
      const idx = options.findIndex((o) => o.value === value);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = options[(idx + 1) % options.length];
        if (next) onChange(next.value);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = options[(idx - 1 + options.length) % options.length];
        if (prev) onChange(prev.value);
      }
    },
    [disabled, open, options, value, onChange, close]
  );

  const wrapperClass = [
    'ui-select-wrapper',
    open ? 'open' : '',
    disabled ? 'disabled' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={wrapperRef} className={wrapperClass} id={id}>
      <button
        type="button"
        className="ui-select-trigger"
        onClick={toggle}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
      >
        <span className="ui-select-value">{selectedOption ? selectedOption.label : ''}</span>
        <svg
          className="ui-select-arrow"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path
            d="M6 9l6 6 6-6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <div className="ui-select-menu" role="listbox" id={listboxId} aria-hidden={!open}>
        {options.map((opt) => {
          const isSelected = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={isSelected}
              className={`ui-select-option${isSelected ? ' selected' : ''}`}
              onClick={() => {
                onChange(opt.value);
                close();
              }}
            >
              <span className="ui-select-option-indicator" aria-hidden="true">
                {isSelected && (
                  <svg
                    className="ui-select-check"
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    aria-hidden="true"
                  >
                    <path
                      d="M20 6L9 17l-5-5"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </span>
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
