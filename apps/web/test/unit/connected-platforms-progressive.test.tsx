import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('@/hooks/useActiveDashboardContext', () => ({
  useActiveDashboardContext: vi.fn(() => ({
    activeGuildId: undefined,
    activeTenantId: 'user-123',
    isPersonalDashboard: true,
    selectedGuild: undefined,
    viewer: { authUserId: 'user-123' },
  })),
}));

vi.mock('@/lib/dashboard', () => ({
  buildProviderConnectUrl: vi.fn(
    (provider: { connectPath?: string }) => provider.connectPath ?? null
  ),
  disconnectDashboardConnection: vi.fn(),
  getProviderIconPath: vi.fn((provider: { icon?: string | null }) =>
    provider.icon ? `/Icons/${provider.icon}` : null
  ),
  listDashboardConnections: vi.fn(),
  listDashboardProviders: vi.fn(),
}));

import { ConnectedPlatformsPanel } from '@/components/dashboard/panels/ConnectedPlatformsPanel';
import * as dashboardApi from '@/lib/dashboard';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

const THREE_UNCONNECTED_PROVIDERS = [
  {
    connectParamStyle: 'camelCase',
    connectPath: '/setup/gumroad',
    icon: 'Gumroad.png',
    key: 'gumroad',
    label: 'Gumroad',
  },
  {
    connectParamStyle: 'camelCase',
    connectPath: '/setup/patreon',
    icon: 'Patreon.png',
    key: 'patreon',
    label: 'Patreon',
  },
  {
    connectParamStyle: 'camelCase',
    connectPath: '/setup/kofi',
    icon: 'Ko-fi.png',
    key: 'kofi',
    label: 'Ko-fi',
  },
];

describe('ConnectedPlatformsPanel progressive disclosure', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    const portalHost = document.createElement('div');
    portalHost.id = 'portal-root';
    document.body.appendChild(portalHost);
  });

  it('uses the loaded sales-channel list insets while provider data is loading', () => {
    const pendingProviders = new Promise<never>(() => {});
    const pendingConnections = new Promise<never>(() => {});
    vi.mocked(dashboardApi.listDashboardProviders).mockReturnValue(pendingProviders);
    vi.mocked(dashboardApi.listDashboardConnections).mockReturnValue(pendingConnections);

    const { container } = render(<ConnectedPlatformsPanel />, { wrapper: createWrapper() });

    expect(container.querySelector('.skeleton-stack.cpp-panel__list')).toBeInTheDocument();
  });

  it('collapses unconnected providers behind "Show X more" when none are connected', async () => {
    vi.mocked(dashboardApi.listDashboardProviders).mockResolvedValue(THREE_UNCONNECTED_PROVIDERS);
    vi.mocked(dashboardApi.listDashboardConnections).mockResolvedValue([]);

    render(<ConnectedPlatformsPanel />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('Show 3 more')).toBeInTheDocument());

    // Discord counts as one connected channel, so the visible total is one of four.
    expect(screen.getByText('1 of 4')).toBeVisible();

    // Unconnected provider labels must NOT be rendered
    expect(screen.queryByText('Gumroad')).not.toBeInTheDocument();
    expect(screen.queryByText('Patreon')).not.toBeInTheDocument();
    expect(screen.queryByText('Ko-fi')).not.toBeInTheDocument();
  });

  it('reveals collapsed providers after clicking "Show X more"', async () => {
    vi.mocked(dashboardApi.listDashboardProviders).mockResolvedValue(THREE_UNCONNECTED_PROVIDERS);
    vi.mocked(dashboardApi.listDashboardConnections).mockResolvedValue([]);

    render(<ConnectedPlatformsPanel />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('Show 3 more')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Show 3 more'));

    // After expanding, all 3 providers are rendered (label appears in row + portal dialog)
    await waitFor(() => expect(screen.getAllByText('Gumroad').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Patreon').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Ko-fi').length).toBeGreaterThan(0);
    expect(screen.getByText('Show less')).toBeInTheDocument();
    expect(screen.queryByText('Show 3 more')).not.toBeInTheDocument();
  });

  it('shows no "Show X more" button when all providers are connected', async () => {
    vi.mocked(dashboardApi.listDashboardProviders).mockResolvedValue([
      {
        connectParamStyle: 'camelCase',
        connectPath: '/setup/gumroad',
        icon: 'Gumroad.png',
        key: 'gumroad',
        label: 'Gumroad',
      },
    ]);
    vi.mocked(dashboardApi.listDashboardConnections).mockResolvedValue([
      {
        connectionType: 'setup',
        createdAt: 1,
        hasAccessToken: true,
        hasApiKey: false,
        id: 'connection-1',
        label: 'Gumroad Store',
        provider: 'gumroad',
        status: 'active',
        updatedAt: 2,
        webhookConfigured: true,
      },
    ]);

    render(<ConnectedPlatformsPanel />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('Gumroad Store')).toBeInTheDocument());

    expect(screen.queryByText(/Show \d+ more/)).not.toBeInTheDocument();
  });

  it('requires holding the final disconnect action', async () => {
    vi.mocked(dashboardApi.listDashboardProviders).mockResolvedValue([
      {
        connectParamStyle: 'camelCase',
        connectPath: '/setup/gumroad',
        icon: 'Gumroad.png',
        key: 'gumroad',
        label: 'Gumroad',
      },
    ]);
    vi.mocked(dashboardApi.listDashboardConnections).mockResolvedValue([
      {
        connectionType: 'setup',
        createdAt: 1,
        hasAccessToken: true,
        hasApiKey: false,
        id: 'connection-1',
        label: 'Gumroad Store',
        provider: 'gumroad',
        status: 'active',
        updatedAt: 2,
        webhookConfigured: true,
      },
    ]);

    render(<ConnectedPlatformsPanel />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('Gumroad Store')).toBeInTheDocument());
    const disconnectTrigger = screen
      .getAllByRole('button', { name: 'Disconnect' })
      .find((button) => button.classList.contains('platform-row-btn'));
    if (!disconnectTrigger) {
      throw new Error('Platform disconnect trigger was not rendered');
    }
    fireEvent.click(disconnectTrigger);

    expect(screen.getByRole('button', { name: /hold to disconnect gumroad/i })).toBeInTheDocument();
  });
});
