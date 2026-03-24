import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => {
  return {
    createFileRoute: () => (options: unknown) => ({ options }),
    useNavigate: vi.fn(() => vi.fn()),
  };
});

vi.mock('convex/react', () => {
  return {
    useMutation: vi.fn(() => vi.fn(() => Promise.resolve())),
    useQuery: vi.fn(() => undefined),
  };
});

vi.mock('@/hooks/useDashboardSession', () => {
  return {
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
  };
});

vi.mock('@/hooks/useDashboardShell', () => {
  return {
    useDashboardShell: vi.fn(() => ({
      guilds: [],
      selectedGuild: undefined,
      viewer: {
        authUserId: 'user-123',
      },
    })),
  };
});

vi.mock('@/hooks/useServerContext', () => {
  return {
    useServerContext: vi.fn(() => ({
      guildId: undefined,
      isPersonalDashboard: true,
      tenantId: undefined,
    })),
  };
});

vi.mock('@/hooks/useActiveDashboardContext', () => {
  return {
    useActiveDashboardContext: vi.fn(() => ({
      activeGuildId: undefined,
      activeTenantId: 'user-123',
      isPersonalDashboard: true,
      selectedGuild: undefined,
      viewer: { authUserId: 'user-123' },
    })),
  };
});

vi.mock('@/components/ui/Toast', () => {
  return {
    useToast: vi.fn(() => ({
      error: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
    })),
  };
});

vi.mock('@/lib/dashboard', () => {
  return {
    buildProviderConnectUrl: vi.fn(
      (provider: { connectPath?: string }) => provider.connectPath ?? null
    ),
    disconnectDashboardConnection: vi.fn(),
    disconnectUserAccount: vi.fn(),
    getDashboardSettings: vi.fn(),
    getProviderIconPath: vi.fn((provider: { icon?: string | null }) =>
      provider.icon ? `/Icons/${provider.icon}` : null
    ),
    listDashboardConnections: vi.fn(),
    listDashboardProviders: vi.fn(),
    listGuildChannels: vi.fn(),
    listUserAccounts: vi.fn(),
    uninstallGuild: vi.fn(),
    updateDashboardSetting: vi.fn(),
  };
});

import * as dashboardApi from '@/lib/dashboard';
import { Route as DashboardIndexRoute } from '@/routes/dashboard/index';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('dashboard connected platforms', () => {
  beforeEach(() => {
    document.body.innerHTML = '';

    const portalHost = document.createElement('div');
    portalHost.id = 'portal-root';
    document.body.appendChild(portalHost);

    vi.mocked(dashboardApi.listDashboardProviders).mockResolvedValue([
      {
        connectParamStyle: 'camelCase',
        connectPath: '/setup/jinxxy',
        icon: 'Jinxxy.png',
        key: 'jinxxy',
        label: 'Jinxxy',
      },
    ]);

    vi.mocked(
      (
        dashboardApi as unknown as {
          listDashboardConnections: ReturnType<typeof vi.fn>;
        }
      ).listDashboardConnections
    ).mockResolvedValue([
      {
        connectionType: 'setup',
        createdAt: 1,
        hasAccessToken: true,
        hasApiKey: false,
        id: 'connection-1',
        label: 'Creator storefront',
        provider: 'jinxxy',
        status: 'active',
        updatedAt: 2,
        webhookConfigured: true,
      },
    ]);

    vi.mocked(dashboardApi.listUserAccounts).mockResolvedValue([
      // The personal account route should not drive dashboard storefront cards.
    ]);
  });

  it('loads linked platform accounts from the dashboard API even when Convex reactive queries are unavailable', async () => {
    const Component = DashboardIndexRoute.options.component;
    if (!Component) {
      throw new Error('Dashboard index route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(dashboardApi.listDashboardProviders).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        vi.mocked(
          (
            dashboardApi as unknown as {
              listDashboardConnections: ReturnType<typeof vi.fn>;
            }
          ).listDashboardConnections
        )
      ).toHaveBeenCalled()
    );

    await waitFor(() => expect(screen.getByText('Creator storefront')).toBeInTheDocument());
    expect(screen.getAllByText('Jinxxy').length).toBeGreaterThan(0);
  });

  it('disconnects creator storefronts through the creator connection endpoint', async () => {
    const Component = DashboardIndexRoute.options.component;
    if (!Component) {
      throw new Error('Dashboard index route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('Creator storefront')).toBeInTheDocument());

    const creatorRow = screen.getByText('Creator storefront').closest('.platform-row');
    const disconnectButton = creatorRow?.querySelector('button.platform-row-btn.disconnect');
    if (!(disconnectButton instanceof HTMLButtonElement)) {
      throw new Error('Disconnect button was not rendered for the creator storefront row');
    }

    fireEvent.click(disconnectButton);

    const confirmButton = document.getElementById('jinxxy-confirm-btn');
    if (!(confirmButton instanceof HTMLButtonElement)) {
      throw new Error('Disconnect confirmation button was not rendered');
    }

    fireEvent.click(confirmButton);

    await waitFor(() =>
      expect(
        vi.mocked(
          (
            dashboardApi as unknown as {
              disconnectDashboardConnection: ReturnType<typeof vi.fn>;
            }
          ).disconnectDashboardConnection
        )
      ).toHaveBeenCalledWith('connection-1', 'user-123')
    );
  });
});
