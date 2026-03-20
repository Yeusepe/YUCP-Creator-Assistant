import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardBodyPortal } from '@/components/dashboard/DashboardBodyPortal';

process.env.CONVEX_SITE_URL ??= 'https://example.convex.site';
process.env.CONVEX_URL ??= 'https://example.convex.cloud';

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

vi.mock('@/lib/dashboard', async () => {
  const actual = await vi.importActual<typeof import('@/lib/dashboard')>('@/lib/dashboard');

  return {
    ...actual,
    listOAuthApps: vi.fn(),
    listPublicApiKeys: vi.fn(),
  };
});

import * as dashboardApi from '@/lib/dashboard';
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

describe('dashboard inline panels', () => {
  beforeEach(() => {
    for (const existingHost of document.querySelectorAll('#portal-root')) {
      existingHost.remove();
    }

    vi.mocked(dashboardApi.listOAuthApps).mockResolvedValue([]);
    vi.mocked(dashboardApi.listPublicApiKeys).mockResolvedValue([]);
  });

  it('portals the add-app panel to the shared dashboard portal host', async () => {
    const Component = IntegrationsRoute.options.component;
    if (!Component) {
      throw new Error('Integrations route component is not defined');
    }

    const portalHost = document.createElement('div');
    portalHost.id = 'portal-root';
    document.body.appendChild(portalHost);

    const { container } = render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /add app/i })).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole('button', { name: /^add app$/i }));

    const panel = await screen.findByLabelText(/close oauth app panel/i);
    const portalRoot = panel.closest('#create-oauth-app-panel');
    const sharedPortalHost = document.getElementById('portal-root');

    expect(portalRoot).not.toBeNull();
    expect(sharedPortalHost).not.toBeNull();
    expect(portalRoot?.parentElement).toBe(sharedPortalHost);
    expect(container.contains(portalRoot as Node)).toBe(false);
  });

  it('uses the shared portal host instead of mounting dashboard overlays directly on body', async () => {
    const portalHost = document.createElement('div');
    portalHost.id = 'portal-root';
    document.body.appendChild(portalHost);

    render(
      <DashboardBodyPortal>
        <div data-testid="portal-child">Portal child</div>
      </DashboardBodyPortal>
    );

    await waitFor(() => expect(screen.getByTestId('portal-child')).toBeInTheDocument());

    const portalChild = screen.getByTestId('portal-child');
    expect(portalChild.parentElement).toBe(portalHost);
  });
});
