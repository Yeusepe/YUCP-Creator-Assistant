import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/dashboard', async () => {
  return {
    fetchDashboardViewer: vi.fn(),
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
import { fetchDashboardViewer } from '@/lib/server/dashboard';
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
    vi.mocked(fetchDashboardViewer).mockResolvedValue({ authUserId: 'user-123' });
    vi.mocked(dashboardApi.listOAuthApps).mockResolvedValue([]);
    vi.mocked(dashboardApi.listPublicApiKeys).mockResolvedValue([]);
  });

  it('portals the add-app panel to document.body so it is not clipped by dashboard cards', async () => {
    const Component = IntegrationsRoute.options.component;
    if (!Component) {
      throw new Error('Integrations route component is not defined');
    }

    const { container } = render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /add app/i })).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole('button', { name: /^add app$/i }));

    const panel = await screen.findByLabelText(/close oauth app panel/i);
    const portalRoot = panel.closest('#create-oauth-app-panel');

    expect(portalRoot).not.toBeNull();
    expect(portalRoot?.parentElement).toBe(document.body);
    expect(container.contains(portalRoot as Node)).toBe(false);
  });
});
