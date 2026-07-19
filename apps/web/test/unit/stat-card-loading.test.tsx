import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatCard } from '@/components/dashboard/cards/StatCard';

describe('StatCard loading state', () => {
  it('shows skeleton (aria-hidden) not the value "0" when loading', () => {
    const { container } = render(<StatCard label="Test" value={0} icon={null} loading={true} />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('shows value "42" when not loading', () => {
    render(<StatCard label="Test" value={42} icon={null} loading={false} />);

    expect(screen.getByText('42')).toBeVisible();
  });

  it('shows value "0" correctly when not loading and value is genuinely 0', () => {
    render(<StatCard label="Verified Members" value={0} icon={null} loading={false} />);

    expect(screen.getByText('0')).toBeVisible();
  });
});
