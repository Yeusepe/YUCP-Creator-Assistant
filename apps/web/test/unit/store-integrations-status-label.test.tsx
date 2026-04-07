import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  createLazyFileRoute: () => (options: unknown) => ({ options }),
  createFileRoute: () => (options: unknown) => ({ options }),
}));

vi.mock('@/hooks/useDashboardSession', () => ({
  isDashboardAuthError: vi.fn(() => false),
  useDashboardSession: vi.fn(() => ({
    canRunPanelQueries: true,
    clearSessionExpired: vi.fn(),
    hasHydrated: true,
    isAuthenticated: true,
    isAuthResolved: true,
    isSessionExpired: false,
    markSessionExpired: vi.fn(),
    status: 'active',
  })),
}));

vi.mock('@/lib/dashboardQueryOptions', () => ({
  dashboardPanelQueryOptions: vi.fn((opts: Record<string, unknown>) => ({
    ...opts,
    staleTime: 0,
    retry: false,
  })),
}));

vi.mock('@/lib/dashboard', () => ({
  buildProviderConnectUrl: vi.fn(() => '/setup/gumroad'),
  getConnectionStatus: vi.fn(() => Promise.resolve({ gumroad: true })),
  getProviderIconPath: vi.fn(() => '/Icons/Gumroad.png'),
  listDashboardConnections: vi.fn(() => Promise.resolve([])),
  listDashboardProviders: vi.fn(() =>
    Promise.resolve([{ key: 'gumroad', label: 'Gumroad', iconBg: '#ff90e8' }])
  ),
}));

import { StoreRow } from '@/components/dashboard/panels/StoreIntegrationsPanel';
import type { UserAccountConnection } from '@/lib/dashboard';

function makeAccount(status: string): UserAccountConnection {
  return {
    connectionType: 'setup',
    createdAt: 1,
    hasAccessToken: true,
    hasApiKey: false,
    id: 'acct-1',
    label: 'My Store',
    provider: 'gumroad',
    status,
    updatedAt: 2,
    webhookConfigured: true,
  } as UserAccountConnection;
}

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

const provider = { key: 'gumroad', label: 'Gumroad', iconBg: '#ff90e8' };

describe('StoreRow status label', () => {
  afterEach(() => cleanup());
  it('shows "Connected" for active status', () => {
    render(
      <StoreRow
        provider={provider}
        account={makeAccount('active')}
        authUserId="user-1"
        guildId="guild-1"
      />,
      { wrapper: createWrapper() }
    );
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('shows "Needs attention" for degraded status', () => {
    render(
      <StoreRow
        provider={provider}
        account={makeAccount('degraded')}
        authUserId="user-1"
        guildId="guild-1"
      />,
      { wrapper: createWrapper() }
    );
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
  });

  it('shows "Not connected" for disconnected status (not "Connected")', () => {
    render(
      <StoreRow
        provider={provider}
        account={makeAccount('disconnected')}
        authUserId="user-1"
        guildId="guild-1"
      />,
      { wrapper: createWrapper() }
    );
    expect(screen.getByText('Not connected')).toBeInTheDocument();
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });

  it('shows "Not connected" when no account exists (undefined), not "Connected"', () => {
    render(
      <StoreRow
        provider={provider}
        account={undefined}
        authUserId="user-1"
        guildId="guild-1"
      />,
      { wrapper: createWrapper() }
    );
    expect(screen.getByText('Not connected')).toBeInTheDocument();
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });
});
