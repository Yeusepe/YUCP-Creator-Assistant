import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlatformCard } from '@/components/dashboard/cards/PlatformCard';

afterEach(cleanup);

const baseProps = {
  providerKey: 'test',
  label: 'Test Platform',
  iconPath: null,
  isConnected: false,
  onConnect: vi.fn(),
  onDisconnect: vi.fn(),
};

describe('PlatformCard, YucpButton migration', () => {
  it('renders the Connect button with btn-primary class', () => {
    render(<PlatformCard {...baseProps} isConnected={false} />);
    const btn = screen.getByRole('button', { name: 'Connect' });
    expect(btn).toHaveClass('btn-primary');
  });

  it('renders the Disconnect button with btn-danger class', () => {
    render(<PlatformCard {...baseProps} isConnected={true} />);
    const btn = screen.getByRole('button', { name: 'Disconnect' });
    expect(btn).toHaveClass('btn-danger');
  });

  it('disables the Disconnect button while disconnecting', () => {
    render(<PlatformCard {...baseProps} isConnected={true} isDisconnecting={true} />);
    expect(screen.getByRole('button', { name: /Disconnecting/i })).toBeDisabled();
  });

  it('shows "Disconnecting..." text while disconnecting', () => {
    render(<PlatformCard {...baseProps} isConnected={true} isDisconnecting={true} />);
    expect(screen.getByRole('button', { name: /Disconnecting/i })).toBeInTheDocument();
  });

  it('keeps platform-row-btn class on Connect button for CSS compatibility', () => {
    render(<PlatformCard {...baseProps} isConnected={false} />);
    const btn = screen.getByRole('button', { name: 'Connect' });
    expect(btn).toHaveClass('platform-row-btn');
  });

  it('keeps platform-row-btn disconnect class on Disconnect button for CSS compatibility', () => {
    render(<PlatformCard {...baseProps} isConnected={true} />);
    const btn = screen.getByRole('button', { name: 'Disconnect' });
    expect(btn).toHaveClass('platform-row-btn', 'disconnect');
  });

  it('renders "Always active" badge and no buttons when isAlwaysActive is true', () => {
    render(<PlatformCard {...baseProps} isAlwaysActive={true} />);
    expect(screen.getByText('Always active')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
