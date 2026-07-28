import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';

vi.mock('@tanstack/react-router', () => {
  return {
    createFileRoute: () => (options: unknown) => ({ options }),
    createLazyFileRoute: () => (options: unknown) => ({ options }),
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

vi.mock('@/hooks/useActiveDashboardContext', () => {
  return {
    useActiveDashboardContext: vi.fn(),
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
    getCreatorIdentity: vi.fn(),
    getDashboardSettings: vi.fn(),
    getProviderIconPath: vi.fn((provider: { icon?: string | null }) =>
      provider.icon ? `/Icons/${provider.icon}` : null
    ),
    listDashboardProviders: vi.fn(),
    listGuildChannels: vi.fn(),
    listUserAccounts: vi.fn(),
    uninstallGuild: vi.fn(),
    updateCreatorIdentity: vi.fn(),
    updateDashboardSetting: vi.fn(),
  };
});

import { useActiveDashboardContext } from '@/hooks/useActiveDashboardContext';
import { useDashboardSession } from '@/hooks/useDashboardSession';
import { useDashboardShell } from '@/hooks/useDashboardShell';
import { useServerContext } from '@/hooks/useServerContext';
import * as dashboardApi from '@/lib/dashboard';
import { Route as DashboardIndexRoute } from '@/routes/_authenticated/dashboard/index.lazy';
import { TestRuntimeConfigProvider } from './support/TestRuntimeConfigProvider';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <TestRuntimeConfigProvider>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </TestRuntimeConfigProvider>
    );
  };
}

describe('dashboard server settings', () => {
  beforeEach(() => {
    document.body.innerHTML = '';

    vi.mocked(dashboardApi.listDashboardProviders).mockReset();
    vi.mocked(dashboardApi.listUserAccounts).mockReset();
    vi.mocked(dashboardApi.getConnectionStatus).mockReset();
    vi.mocked(dashboardApi.getCreatorIdentity).mockReset();
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

    vi.mocked(useActiveDashboardContext).mockReturnValue({
      activeGuildId: 'guild-123',
      activeTenantId: 'tenant-123',
      isPersonalDashboard: false,
      selectedGuild: {
        icon: null,
        id: 'guild-123',
        name: 'Creator HQ',
        tenantId: 'tenant-123',
      },
      viewer: { authUserId: 'user-123' },
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
    vi.mocked(dashboardApi.getCreatorIdentity).mockResolvedValue({
      deliverySlug: 'creator-10705330',
      name: 'Creator 10705330',
      privateVpmHostname: 'creator-10705330.private.yucp.club',
      publicSlug: 'creator-10705330',
    });
    vi.mocked(dashboardApi.updateCreatorIdentity).mockResolvedValue({
      deliverySlug: 'mapache',
      name: 'Mapache',
      privateVpmHostname: 'mapache.private.yucp.club',
      publicSlug: 'mapache',
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

    expect(screen.getByText('General Settings')).toBeInTheDocument();
    expect(screen.getByText('Allow Mismatched Emails')).toBeInTheDocument();
    expect(screen.getByText('Verification Scope')).toBeInTheDocument();
    expect(screen.getAllByText('Jinxxy').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: '#logs' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: '#announcements' }).length).toBeGreaterThan(0);
  });

  it('lets the creator rename their display identity and owned link namespaces', async () => {
    const Component = DashboardIndexRoute.options.component;
    if (!Component) {
      throw new Error('Dashboard index route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    const nameInput = await screen.findByRole('textbox', { name: 'Creator display name' });
    const publicHandleInput = screen.getByRole('textbox', { name: 'Public creator handle' });
    const privateHostInput = screen.getByRole('textbox', { name: 'Private VPM subdomain' });
    fireEvent.change(nameInput, { target: { value: 'Mapache' } });
    fireEvent.change(publicHandleInput, { target: { value: 'mapache' } });
    fireEvent.change(privateHostInput, { target: { value: 'mapache' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save creator identity' }));

    await waitFor(() =>
      expect(dashboardApi.updateCreatorIdentity).toHaveBeenCalledWith({
        deliverySlug: 'mapache',
        name: 'Mapache',
        publicSlug: 'mapache',
      })
    );
    expect(await screen.findByText('mapache.private.yucp.club')).toBeInTheDocument();
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

    vi.mocked(useActiveDashboardContext).mockReturnValue({
      activeGuildId: 'guild-123',
      activeTenantId: 'tenant-123',
      isPersonalDashboard: false,
      selectedGuild: {
        icon: null,
        id: 'guild-123',
        name: 'Creator HQ',
        tenantId: 'tenant-123',
      },
      viewer: { authUserId: 'viewer-tenant' },
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

  it('unmounts dashboard setup skeletons once the loaded content is rendered', async () => {
    const Component = DashboardIndexRoute.options.component;
    if (!Component) {
      throw new Error('Dashboard index route component is not defined');
    }

    const { container } = render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('Allow Mismatched Emails')).toBeInTheDocument());

    expect(
      container.querySelector('.skeleton-action-row, .skeleton-grid, .skeleton-stack')
    ).toBeNull();
  });
});
