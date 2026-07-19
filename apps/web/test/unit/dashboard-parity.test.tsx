import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectedPlatformsPanel } from '@/components/dashboard/panels/ConnectedPlatformsPanel';
import { StoreIntegrationsPanel } from '@/components/dashboard/panels/StoreIntegrationsPanel';
import * as dashboardApi from '@/lib/dashboard';
import { dashboardQueryOptions } from '@/lib/dashboardQueryOptions';
import { Route as CollaborationRoute } from '@/routes/_authenticated/dashboard/collaboration.lazy';
import { Route as IntegrationsRoute } from '@/routes/_authenticated/dashboard/integrations.lazy';

vi.mock('@tanstack/react-router', () => ({
  createLazyFileRoute: () => (options: unknown) => ({ options }),
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

vi.mock('@/hooks/useDashboardShell', () => ({
  useDashboardShell: vi.fn(() => ({
    guilds: [],
    selectedGuild: undefined,
    viewer: { authUserId: 'user-123' },
  })),
}));

vi.mock('@/hooks/useDashboardSession', () => ({
  isDashboardAuthError: vi.fn(() => false),
  useDashboardSession: vi.fn(() => ({
    canRunPanelQueries: true,
    isAuthResolved: true,
    markSessionExpired: vi.fn(),
    status: 'active',
  })),
}));

vi.mock('@/lib/dashboard', async () => {
  const actual = await vi.importActual<typeof import('@/lib/dashboard')>('@/lib/dashboard');

  return {
    ...actual,
    createCollabInvite: vi.fn(),
    getConnectionStatus: vi.fn(),
    listCollabConnections: vi.fn(),
    listCollabConnectionsAsCollaborator: vi.fn(),
    listCollabInvites: vi.fn(),
    listCollabProviders: vi.fn(),
    listDashboardConnections: vi.fn(),
    listDashboardProviders: vi.fn(),
    listOAuthApps: vi.fn(),
    listPublicApiKeys: vi.fn(),
  };
});

const providers = [
  {
    connectParamStyle: 'camelCase' as const,
    connectPath: '/setup/jinxxy',
    icon: 'Jinxxy.png',
    key: 'jinxxy',
    label: 'Jinxxy',
  },
  {
    connectParamStyle: 'camelCase' as const,
    connectPath: '/setup/gumroad',
    icon: 'Gumroad.png',
    key: 'gumroad',
    label: 'Gumroad',
  },
];

const jinxxyConnection = {
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
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function routeComponent(route: { options: { component?: React.ComponentType } }) {
  const Component = route.options.component;
  if (!Component) {
    throw new Error('Route component is not defined');
  }
  return Component;
}

describe('dashboard user-visible contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '<div id="portal-root"></div>';

    vi.mocked(dashboardApi.listDashboardProviders).mockResolvedValue(providers);
    vi.mocked(dashboardApi.listDashboardConnections).mockResolvedValue([jinxxyConnection]);
    vi.mocked(dashboardApi.getConnectionStatus).mockResolvedValue({ jinxxy: true });
    vi.mocked(dashboardApi.listOAuthApps).mockResolvedValue([]);
    vi.mocked(dashboardApi.listPublicApiKeys).mockResolvedValue([]);
    vi.mocked(dashboardApi.listCollabProviders).mockResolvedValue([]);
    vi.mocked(dashboardApi.listCollabInvites).mockResolvedValue([]);
    vi.mocked(dashboardApi.listCollabConnections).mockResolvedValue([]);
    vi.mocked(dashboardApi.listCollabConnectionsAsCollaborator).mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  it('loads personal platform cards from the active dashboard tenant', async () => {
    render(<ConnectedPlatformsPanel />, { wrapper: createWrapper() });

    await screen.findByText('Creator storefront');

    expect(dashboardApi.listDashboardConnections).toHaveBeenCalledWith('user-123');
    expect(screen.getByText('2 of 3')).toBeInTheDocument();
  });

  it('derives server storefront tiles from tenant status rather than viewer accounts', async () => {
    vi.mocked(dashboardApi.listDashboardConnections).mockResolvedValue([]);

    render(
      <StoreIntegrationsPanel
        authUserId="tenant-456"
        guildId="guild-789"
        canRunPanelQueries={true}
      />,
      { wrapper: createWrapper() }
    );

    await screen.findByText('Jinxxy');

    expect(dashboardApi.getConnectionStatus).toHaveBeenCalledWith('tenant-456');
    expect(screen.getByText('1 linked')).toBeInTheDocument();
    expect(screen.getByText('Not connected')).toBeInTheDocument();
  });

  it('shows each connected platform once and reveals disconnected providers on request', async () => {
    render(<ConnectedPlatformsPanel />, { wrapper: createWrapper() });

    await screen.findByText('Creator storefront');
    const panel = screen.getByRole('region', { name: 'Connected platforms' });
    expect(screen.getAllByText('Creator storefront')).toHaveLength(1);
    expect(within(panel).queryByText('Gumroad')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show 1 more' }));

    expect(await within(panel).findByText('Gumroad')).toBeInTheDocument();
    expect(screen.getAllByText('Creator storefront')).toHaveLength(1);
  });

  it('removes platform loading placeholders after provider and connection data resolve', async () => {
    const { container } = render(<ConnectedPlatformsPanel />, { wrapper: createWrapper() });

    await screen.findByText('Creator storefront');
    expect(container.querySelector('.skeleton-action-row, .skeleton-stack')).toBeNull();
  });

  it('loads developer integration data for the dashboard viewer', async () => {
    vi.mocked(dashboardApi.listOAuthApps).mockResolvedValue([
      {
        _creationTime: 1,
        _id: 'app-1',
        authUserId: 'user-123',
        clientId: 'client_123',
        name: 'Creator Portal',
        redirectUris: ['https://creator.example/callback'],
        scopes: ['verification:read'],
      },
    ]);
    vi.mocked(dashboardApi.listPublicApiKeys).mockResolvedValue([
      {
        _creationTime: 1,
        _id: 'key-1',
        authUserId: 'user-123',
        name: 'Production API',
        prefix: 'yucp_live_',
        scopes: ['verification:read'],
        status: 'active',
      },
    ]);

    const Component = routeComponent(IntegrationsRoute);
    render(<Component />, { wrapper: createWrapper() });

    expect(await screen.findByText('Creator Portal')).toBeInTheDocument();
    expect(screen.getByText('Production API')).toBeInTheDocument();
    expect(dashboardApi.listOAuthApps).toHaveBeenCalledWith('user-123');
    expect(dashboardApi.listPublicApiKeys).toHaveBeenCalledWith('user-123');
  });

  it('opens the OAuth and API-key creation controls from the loaded integrations screen', async () => {
    const Component = routeComponent(IntegrationsRoute);
    render(<Component />, { wrapper: createWrapper() });

    await screen.findByText('No OAuth apps yet');
    fireEvent.click(screen.getByRole('button', { name: 'Add app' }));
    expect(await screen.findByText('Register OAuth app')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add key' }));
    expect(await screen.findByText('New API key')).toBeInTheDocument();
  });

  it('renders pending invites, active collaborators, and collaborator stores from their APIs', async () => {
    vi.mocked(dashboardApi.listCollabProviders).mockResolvedValue([
      { key: 'jinxxy', label: 'Jinxxy' },
    ]);
    vi.mocked(dashboardApi.listCollabInvites).mockResolvedValue([
      {
        createdAt: Date.now(),
        expiresAt: Date.now() + 3_600_000,
        id: 'invite-1',
        ownerDisplayName: 'Creator Store',
        providerKey: 'jinxxy',
      },
    ]);
    vi.mocked(dashboardApi.listCollabConnections).mockResolvedValue([
      {
        collaboratorDisplayName: 'Partner Creator',
        createdAt: Date.now(),
        id: 'connection-1',
        linkType: 'account',
        provider: 'jinxxy',
        source: 'partner',
        status: 'active',
        webhookConfigured: true,
      },
    ]);
    vi.mocked(dashboardApi.listCollabConnectionsAsCollaborator).mockResolvedValue([
      {
        createdAt: Date.now(),
        id: 'store-1',
        linkType: 'account',
        ownerAuthUserId: 'owner-1',
        ownerDisplayName: 'Shared Store',
        provider: 'jinxxy',
      },
    ]);

    const Component = routeComponent(CollaborationRoute);
    render(<Component />, { wrapper: createWrapper() });

    expect(await screen.findByText('Pending Invites')).toBeInTheDocument();
    expect(screen.getByText('Partner Creator')).toBeInTheDocument();
    expect(screen.getByText('Shared Store')).toBeInTheDocument();
    expect(dashboardApi.listCollabConnections).toHaveBeenCalledWith('user-123');
  });

  it('generates an invite and copies the returned share URL', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    vi.mocked(dashboardApi.listCollabProviders).mockResolvedValue([
      { key: 'jinxxy', label: 'Jinxxy' },
    ]);
    vi.mocked(dashboardApi.createCollabInvite).mockResolvedValue({
      expiresAt: Date.now() + 3_600_000,
      inviteId: 'invite-1',
      inviteUrl: 'https://app.example/collab-invite?id=invite-1',
    });

    const Component = routeComponent(CollaborationRoute);
    render(<Component />, { wrapper: createWrapper() });

    await screen.findByText('No collaborators yet.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Invite a Creator' })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Generate Invite Link' }));

    const shareUrl = await screen.findByText('https://app.example/collab-invite?id=invite-1');
    expect(shareUrl).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('https://app.example/collab-invite?id=invite-1')
    );
  });

  it('does not retry a failing dashboard request', async () => {
    const queryClient = new QueryClient();
    const queryFn = vi.fn().mockRejectedValue(new Error('dashboard unavailable'));

    const { result } = renderHook(
      () =>
        useQuery(
          dashboardQueryOptions({
            queryKey: ['dashboard-parity-failure'],
            queryFn,
          })
        ),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryFn).toHaveBeenCalledTimes(1);
  });
});

function createWrapperWithClient(queryClient: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}
