/**
 * A11y contract tests for the Select component.
 *
 * The ARIA spec requires:
 *  - An element with role="listbox" containing the options
 *  - Each option must have role="option", NOT on a <button> element
 *  - Selected option must have aria-selected="true"
 *
 * References:
 *   https://www.w3.org/WAI/ARIA/apg/patterns/listbox/
 *   https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Roles/option_role
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Select } from '@/components/ui/Select';

const OPTS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
];

describe('Select, ARIA / a11y', () => {
  it('renders the trigger as a button with aria-haspopup="listbox"', () => {
    render(<Select value="a" options={OPTS} onChange={() => {}} />);
    const trigger = screen.getByRole('button');
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
  });

  it('listbox container has role="listbox"', () => {
    const { container } = render(<Select value="a" options={OPTS} onChange={() => {}} />);
    const listbox = container.querySelector('[role="listbox"]');
    expect(listbox).not.toBeNull();
  });

  it('option items have role="option" and are not <button> elements', () => {
    const { container } = render(<Select value="a" options={OPTS} onChange={() => {}} />);
    const options = Array.from(container.querySelectorAll('[role="option"]'));
    expect(options.length).toBe(3);
    for (const opt of options) {
      expect(opt.tagName).not.toBe('BUTTON');
    }
  });

  it('no <button> elements have role="option"', () => {
    const { container } = render(<Select value="a" options={OPTS} onChange={() => {}} />);
    const badButtons = container.querySelectorAll('button[role="option"]');
    expect(badButtons.length).toBe(0);
  });

  it('selected option has aria-selected="true"', () => {
    const { container } = render(<Select value="b" options={OPTS} onChange={() => {}} />);
    const options = Array.from(container.querySelectorAll('[role="option"]'));
    const beta = options.find((o) => o.textContent?.includes('Beta'));
    expect(beta).not.toBeNull();
    expect(beta).toHaveAttribute('aria-selected', 'true');
  });
});
