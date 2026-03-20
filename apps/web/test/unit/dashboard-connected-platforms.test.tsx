import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
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
    disconnectUserAccount: vi.fn(),
    getDashboardSettings: vi.fn(),
    getProviderIconPath: vi.fn((provider: { icon?: string | null }) =>
      provider.icon ? `/Icons/${provider.icon}` : null
    ),
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

    vi.mocked(dashboardApi.listUserAccounts).mockResolvedValue([
      {
        connectionType: 'oauth',
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
  });

  it('loads linked platform accounts from the dashboard API even when Convex reactive queries are unavailable', async () => {
    const Component = DashboardIndexRoute.options.component;
    if (!Component) {
      throw new Error('Dashboard index route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(dashboardApi.listDashboardProviders).toHaveBeenCalled());
    await waitFor(() => expect(dashboardApi.listUserAccounts).toHaveBeenCalled());

    await waitFor(() => expect(screen.getByText('Creator storefront')).toBeInTheDocument());
    expect(screen.getAllByText('Jinxxy').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Connected').length).toBeGreaterThan(0);
  });
});
