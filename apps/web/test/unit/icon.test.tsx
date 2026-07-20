import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Icon } from '@/components/ui/Icon';
import type { IconName } from '@/icons/manifest';

describe('Icon', () => {
  afterEach(() => cleanup());

  it('renders a manifest icon as an SVG that inherits currentColor', () => {
    render(<Icon name="package" className="package-icon" data-testid="package-icon" />);

    const icon = screen.getByTestId('package-icon');
    expect(icon.tagName.toLowerCase()).toBe('svg');
    expect(icon).toHaveClass('package-icon');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon.querySelector('[fill="currentColor"]')).not.toBeNull();
    expect(icon.innerHTML).not.toMatch(/#8fbffa|#2859c5/i);
  });

  it('uses the optional accessible label', () => {
    render(<Icon name="leakTrace" label="Leak trace" />);

    expect(screen.getByRole('img', { name: 'Leak trace' })).not.toHaveAttribute('aria-hidden');
  });

  it('throws instead of silently rendering an unknown icon', () => {
    expect(() => render(<Icon name={'not-in-the-manifest' as IconName} />)).toThrow(
      'Unknown icon name: not-in-the-manifest'
    );
  });
});
