import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('@/hooks/useDashboardSession', async () => {
  return {
    isDashboardAuthError: vi.fn(() => false),
    useDashboardSession: vi.fn(),
  };
});

vi.mock('@/lib/dashboard', async () => {
  const actual = await vi.importActual<typeof import('@/lib/dashboard')>('@/lib/dashboard');

  return {
    ...actual,
    listOAuthApps: vi.fn(),
    listPublicApiKeys: vi.fn(),
    listCollabProviders: vi.fn(),
    listCollabInvites: vi.fn(),
    listCollabConnections: vi.fn(),
    listCollabConnectionsAsCollaborator: vi.fn(),
  };
});

import { useDashboardSession } from '@/hooks/useDashboardSession';
import * as dashboardApi from '@/lib/dashboard';
import { Route as CollaborationRoute } from '@/routes/dashboard/collaboration';
import { Route as IntegrationsRoute } from '@/routes/dashboard/integrations';

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

describe('dashboard auth-required states', () => {
  beforeEach(() => {
    vi.mocked(useDashboardSession).mockReset();
    vi.mocked(dashboardApi.listOAuthApps).mockReset();
    vi.mocked(dashboardApi.listPublicApiKeys).mockReset();
    vi.mocked(dashboardApi.listCollabProviders).mockReset();
    vi.mocked(dashboardApi.listCollabInvites).mockReset();
    vi.mocked(dashboardApi.listCollabConnections).mockReset();
    vi.mocked(dashboardApi.listCollabConnectionsAsCollaborator).mockReset();

    vi.mocked(useDashboardSession).mockReturnValue({
      canRunPanelQueries: false,
      clearSessionExpired: vi.fn(),
      hasHydrated: true,
      isAuthenticated: false,
      isAuthResolved: true,
      isSessionExpired: true,
      markSessionExpired: vi.fn(),
      status: 'expired',
    });

    vi.mocked(dashboardApi.listOAuthApps).mockResolvedValue([]);
    vi.mocked(dashboardApi.listPublicApiKeys).mockResolvedValue([]);
    vi.mocked(dashboardApi.listCollabProviders).mockResolvedValue([]);
    vi.mocked(dashboardApi.listCollabInvites).mockResolvedValue([]);
    vi.mocked(dashboardApi.listCollabConnections).mockResolvedValue([]);
    vi.mocked(dashboardApi.listCollabConnectionsAsCollaborator).mockResolvedValue([]);
  });

  it('renders an auth-required state on developer integrations when viewer auth cannot be resolved', async () => {
    const Component = IntegrationsRoute.options.component;
    if (!Component) {
      throw new Error('Integrations route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(screen.getByText(/sign in to manage developer integrations/i)).toBeInTheDocument()
    );

    expect(dashboardApi.listOAuthApps).not.toHaveBeenCalled();
    expect(dashboardApi.listPublicApiKeys).not.toHaveBeenCalled();
  });

  it('renders an auth-required state on collaboration when viewer auth cannot be resolved', async () => {
    const Component = CollaborationRoute.options.component;
    if (!Component) {
      throw new Error('Collaboration route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(screen.getByText(/sign in to manage collaboration/i)).toBeInTheDocument()
    );

    expect(dashboardApi.listCollabProviders).not.toHaveBeenCalled();
    expect(dashboardApi.listCollabInvites).not.toHaveBeenCalled();
    expect(dashboardApi.listCollabConnections).not.toHaveBeenCalled();
    expect(dashboardApi.listCollabConnectionsAsCollaborator).not.toHaveBeenCalled();
  });
});
