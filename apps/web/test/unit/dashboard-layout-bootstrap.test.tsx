import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeConfigProvider } from '@/lib/runtimeConfig';

const routeSearch = vi.hoisted(() => ({
  value: {
    connect_token: undefined as string | undefined,
    guild_id: 'guild-123',
    setup_token: undefined as string | undefined,
    tenant_id: undefined as string | undefined,
  },
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    search: _search,
    activeProps: _activeProps,
    activeOptions: _activeOptions,
    ...props
  }: {
    children: ReactNode;
    to?: string;
    [key: string]: unknown;
  }) => (
    <a href={typeof to === 'string' ? to : '#'} {...props}>
      {children}
    </a>
  ),
  Outlet: () => <div data-testid="dashboard-outlet" />,
  createFileRoute: () => (options: unknown) => ({
    options,
    useSearch: () => routeSearch.value,
  }),
  createLazyFileRoute: () => (options: unknown) => ({
    options,
    useSearch: () => routeSearch.value,
  }),
  redirect: vi.fn(),
  useNavigate: vi.fn(() => vi.fn()),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: vi.fn(() => ({
    signOut: vi.fn(),
  })),
}));

vi.mock('@/hooks/useDashboardSession', () => ({
  DashboardSessionProvider: ({ children }: PropsWithChildren) => <>{children}</>,
  useDashboardSession: vi.fn(() => ({
    canRunPanelQueries: false,
    clearSessionExpired: vi.fn(),
    hasHydrated: true,
    isAuthenticated: true,
    isAuthResolved: true,
    isSessionExpired: false,
    markSessionExpired: vi.fn(),
    status: 'active',
  })),
}));

vi.mock('@/hooks/useDashboardShell', () => ({
  useDashboardShell: vi.fn(() => ({
    guilds: [],
    selectedGuild: undefined,
    viewer: {
      authUserId: 'user-123',
    },
  })),
}));

vi.mock('@/hooks/useServerContext', () => ({
  ServerContextProvider: ({ children }: PropsWithChildren) => <>{children}</>,
}));

vi.mock('@/hooks/useTheme', () => ({
  useTheme: vi.fn(() => ({
    isDark: false,
    toggleTheme: vi.fn(),
  })),
}));

let DashboardRoute: Awaited<typeof import('@/routes/_authenticated/dashboard.lazy')>['Route'];

describe('dashboard layout bootstrap state', () => {
  beforeAll(async () => {
    ({ Route: DashboardRoute } = await import('@/routes/_authenticated/dashboard.lazy'));
  });

  beforeEach(() => {
    document.body.innerHTML = '';
    routeSearch.value = {
      connect_token: undefined,
      guild_id: 'guild-123',
      setup_token: undefined,
      tenant_id: undefined,
    };
  });

  it('keeps the standard header visible while checking server bootstrap state', () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <RuntimeConfigProvider
          value={{
            automaticSetupEnabled: false,
            browserAuthBaseUrl: 'https://app.example.com',
            buildId: 'test-build',
            privateVpmEnabled: false,
          }}
        >
          <DashboardRoute.options.component />
        </RuntimeConfigProvider>
      </QueryClientProvider>
    );

    expect(html).toContain('content-area-header');
    expect(html).toContain('>Server<');
    expect(html).not.toContain('Finalizing the server link and loading the dashboard.');
  });

  it('does not render the server setup sidebar tab', () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <RuntimeConfigProvider
          value={{
            automaticSetupEnabled: false,
            browserAuthBaseUrl: 'https://app.example.com',
            buildId: 'test-build',
            privateVpmEnabled: false,
          }}
        >
          <DashboardRoute.options.component />
        </RuntimeConfigProvider>
      </QueryClientProvider>
    );

    expect(html).toContain('>General Settings<');
    expect(html).not.toContain('href="/dashboard/setup"');
  });
});
