import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';

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
    useDashboardSession: vi.fn(),
  };
});

vi.mock('@/hooks/useDashboardShell', () => {
  return {
    useDashboardShell: vi.fn(),
  };
});

vi.mock('@/hooks/useServerContext', () => {
  return {
    useServerContext: vi.fn(),
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
    getConnectionStatus: vi.fn(),
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

import { useDashboardSession } from '@/hooks/useDashboardSession';
import { useDashboardShell } from '@/hooks/useDashboardShell';
import { useServerContext } from '@/hooks/useServerContext';
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

describe('dashboard server settings', () => {
  beforeEach(() => {
    document.body.innerHTML = '';

    vi.mocked(dashboardApi.listDashboardProviders).mockReset();
    vi.mocked(dashboardApi.listUserAccounts).mockReset();
    vi.mocked(dashboardApi.getConnectionStatus).mockReset();
    vi.mocked(dashboardApi.getDashboardSettings).mockReset();
    vi.mocked(dashboardApi.listGuildChannels).mockReset();

    const portalHost = document.createElement('div');
    portalHost.id = 'portal-root';
    document.body.appendChild(portalHost);

    vi.mocked(useDashboardSession).mockReturnValue({
      canRunPanelQueries: true,
      clearSessionExpired: vi.fn(),
      hasHydrated: true,
      isAuthenticated: true,
      isAuthResolved: true,
      isSessionExpired: false,
      markSessionExpired: vi.fn(),
      status: 'active',
    });

    vi.mocked(useDashboardShell).mockReturnValue({
      guilds: [
        {
          icon: null,
          id: 'guild-123',
          name: 'Creator HQ',
          tenantId: 'tenant-123',
        },
      ],
      selectedGuild: {
        icon: null,
        id: 'guild-123',
        name: 'Creator HQ',
        tenantId: 'tenant-123',
      },
      viewer: {
        authUserId: 'user-123',
      },
    });

    vi.mocked(useServerContext).mockReturnValue({
      guildId: 'guild-123',
      isPersonalDashboard: false,
      tenantId: 'tenant-123',
    });

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

    vi.mocked(dashboardApi.getConnectionStatus).mockResolvedValue({
      jinxxy: true,
    });

    vi.mocked(dashboardApi.getDashboardSettings).mockResolvedValue({
      allowMismatchedEmails: true,
      announcementsChannelId: 'channel-2',
      logChannelId: 'channel-1',
      verificationScope: 'license',
    });

    vi.mocked(dashboardApi.listGuildChannels).mockResolvedValue([
      { id: 'channel-1', name: 'logs', type: 0 },
      { id: 'channel-2', name: 'announcements', type: 0 },
    ]);
  });

  it('loads per-server settings from the dashboard API even when Convex reactive queries are unavailable', async () => {
    const Component = DashboardIndexRoute.options.component;
    if (!Component) {
      throw new Error('Dashboard index route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(dashboardApi.getConnectionStatus).toHaveBeenCalled());
    await waitFor(() => expect(dashboardApi.getDashboardSettings).toHaveBeenCalled());
    await waitFor(() => expect(dashboardApi.listGuildChannels).toHaveBeenCalled());

    expect(screen.getByText('Server Config')).toBeInTheDocument();
    expect(screen.getByText('Allow Mismatched Emails')).toBeInTheDocument();
    expect(screen.getByText('Verification Scope')).toBeInTheDocument();
    expect(screen.getAllByText('Jinxxy').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('option', { name: '#logs' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('option', { name: '#announcements' }).length).toBeGreaterThan(0);
  });

  it('derives the server settings tenant from the selected guild when route tenant context is missing', async () => {
    const Component = DashboardIndexRoute.options.component;
    if (!Component) {
      throw new Error('Dashboard index route component is not defined');
    }

    vi.mocked(useDashboardShell).mockReturnValue({
      guilds: [
        {
          icon: null,
          id: 'guild-123',
          name: 'Creator HQ',
          tenantId: 'tenant-123',
        },
      ],
      selectedGuild: {
        icon: null,
        id: 'guild-123',
        name: 'Creator HQ',
        tenantId: 'tenant-123',
      },
      viewer: {
        authUserId: 'viewer-tenant',
      },
    });

    vi.mocked(useServerContext).mockReturnValue({
      guildId: 'guild-123',
      isPersonalDashboard: false,
      tenantId: undefined,
    });

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(dashboardApi.getDashboardSettings).toHaveBeenCalledWith('tenant-123')
    );
  });

  it('shows an inline server-config error state when settings cannot be loaded', async () => {
    const Component = DashboardIndexRoute.options.component;
    if (!Component) {
      throw new Error('Dashboard index route component is not defined');
    }

    vi.mocked(dashboardApi.getDashboardSettings).mockRejectedValue(
      new ApiError(500, { error: 'Failed to get settings' })
    );

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(screen.getByText(/could not load server configuration/i)).toBeInTheDocument()
    );

    expect(screen.queryByText('Allow Mismatched Emails')).not.toBeInTheDocument();
  });
});
