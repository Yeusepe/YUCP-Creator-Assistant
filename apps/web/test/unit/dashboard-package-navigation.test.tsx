import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PropsWithChildren, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { navigateMock, routeState } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  routeState: {
    pathname: '/dashboard/packages',
    search: {
      connect_token: undefined as string | undefined,
      guild_id: undefined as string | undefined,
      setup_token: undefined as string | undefined,
      tenant_id: undefined as string | undefined,
      view: undefined as 'forensics' | undefined,
    },
  },
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    activeOptions,
    activeProps,
    children,
    className,
    search,
    to,
    ...props
  }: {
    activeOptions?: { exact?: boolean; includeSearch?: boolean };
    activeProps?: { className?: string };
    children: ReactNode;
    className?: string;
    search?:
      | Record<string, unknown>
      | ((previous: Record<string, unknown>) => Record<string, unknown>);
    to: string;
    [key: string]: unknown;
  }) => {
    const nextSearch =
      typeof search === 'function' ? search(routeState.search) : (search ?? routeState.search);
    const pathIsActive = activeOptions?.exact
      ? routeState.pathname === to
      : routeState.pathname === to || routeState.pathname.startsWith(`${to}/`);
    const searchIsActive =
      activeOptions?.includeSearch === false ||
      Object.entries(nextSearch).every(
        ([key, value]) =>
          value === undefined || routeState.search[key as keyof typeof routeState.search] === value
      );
    const isActive = pathIsActive && searchIsActive;

    return (
      <a
        {...props}
        href={to}
        className={isActive ? (activeProps?.className ?? className) : className}
        aria-current={isActive ? 'page' : undefined}
      >
        {children}
      </a>
    );
  },
  Outlet: () => null,
  createFileRoute: () => (options: unknown) => ({
    options,
    useSearch: () => routeState.search,
  }),
  createLazyFileRoute: () => (options: unknown) => ({
    options,
    useSearch: () => routeState.search,
  }),
  redirect: vi.fn(),
  useNavigate: () => navigateMock,
}));

vi.mock('@/components/dashboard/CouplingForensicsPanel', () => ({
  CouplingForensicsPanel: () => <div>Leak Tracer panel content</div>,
}));

vi.mock('@/components/dashboard/DashboardSkeletons', () => ({
  PackageRegistryWorkspaceSkeleton: () => <div>Uploads loading</div>,
}));

vi.mock('@/components/dashboard/PackageRegistryAccessGate', () => ({
  PackageRegistryAccessGate: () => <div>Package access gate</div>,
}));

vi.mock('@/components/dashboard/PackageRegistryPanel', () => ({
  PackageRegistryPanel: () => <div>Uploads panel content</div>,
}));

vi.mock('@/components/three/CloudBackground', () => ({
  CloudBackground: () => null,
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ signOut: vi.fn() }),
}));

vi.mock('@/hooks/useCreatorCertificateWorkspace', () => ({
  useCreatorCertificateWorkspace: () => ({
    billing: { capabilities: [] },
    hasAuthError: false,
    isLoading: false,
    query: { isError: false, isFetching: false, refetch: vi.fn() },
  }),
}));

vi.mock('@/hooks/useDashboardSession', () => ({
  DashboardSessionProvider: ({ children }: PropsWithChildren) => <>{children}</>,
  useDashboardSession: () => ({
    canRunPanelQueries: true,
    isAuthenticated: true,
    status: 'active',
  }),
}));

vi.mock('@/hooks/useDashboardShell', () => ({
  useDashboardShell: () => ({
    guilds: [],
    selectedGuild: undefined,
    viewer: { authUserId: 'creator-123' },
  }),
}));

vi.mock('@/hooks/useTheme', () => ({
  useTheme: () => ({ isDark: true, toggleTheme: vi.fn() }),
}));

vi.mock('@/hooks/useServerContext', () => ({
  ServerContextProvider: ({ children }: PropsWithChildren) => <>{children}</>,
}));

vi.mock('@/lib/certificates', () => ({
  hasActiveCreatorBillingCapability: () => true,
  listCreatorCertificates: () =>
    Promise.resolve({
      billing: { capabilities: [] },
    }),
}));

vi.mock('@/lib/hyperdx', () => ({
  addHyperdxActionWithNumbers: vi.fn(),
  buildHyperdxNavigationPhases: vi.fn(() => []),
  getHyperdxNavigationSnapshot: vi.fn(() => null),
  getHyperdxSlowestNavigationPhase: vi.fn(() => null),
  recordHyperdxNavigationTrace: vi.fn(),
}));

import { Route as DashboardPackagesRoute } from '@/routes/_authenticated/dashboard/packages.lazy';
import { Route as DashboardRoute } from '@/routes/_authenticated/dashboard.lazy';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function renderPackageNavigation(view: 'forensics' | undefined) {
  routeState.search.view = view;
  const Dashboard = DashboardRoute.options.component;
  const Packages = DashboardPackagesRoute.options.component;
  if (!Dashboard || !Packages) {
    throw new Error('Dashboard package navigation components are missing');
  }

  return render(
    <>
      <Dashboard />
      <Packages />
    </>,
    { wrapper: createWrapper() }
  );
}

describe('dashboard package navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeState.pathname = '/dashboard/packages';
    routeState.search.view = undefined;
  });

  afterEach(() => cleanup());

  it.each([
    { expectedTab: 'Uploads', view: undefined },
    { expectedTab: 'Leak Tracer', view: 'forensics' as const },
  ])('keeps one active sidebar item and one selected in-page tab for view=$view', async ({
    expectedTab,
    view,
  }) => {
    renderPackageNavigation(view);

    const sidebar = screen.getByRole('complementary', { name: 'Main navigation' });
    await waitFor(() =>
      expect(sidebar.querySelectorAll('.sidebar-nav-btn.is-active')).toHaveLength(1)
    );
    expect(within(sidebar).getAllByText('Packages')).toHaveLength(1);
    expect(sidebar.querySelectorAll('[aria-current="page"]')).toHaveLength(1);

    const tablist = screen.getByRole('tablist', { name: 'Package views' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    const selectedTab = within(tablist).getByRole('tab', { name: expectedTab });
    expect(selectedTab).toHaveAttribute('aria-selected', 'true');

    const panelId = selectedTab.getAttribute('aria-controls');
    const panel = panelId ? document.getElementById(panelId) : null;
    expect(panel).toHaveAttribute('role', 'tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', selectedTab.id);
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it('updates the existing view search parameter when switching tabs', () => {
    renderPackageNavigation('forensics');

    fireEvent.click(screen.getByRole('tab', { name: 'Uploads' }));

    expect(navigateMock).toHaveBeenCalledWith({
      to: '/dashboard/packages',
      search: expect.any(Function),
    });
    const searchUpdater = navigateMock.mock.calls[0]?.[0]?.search;
    expect(searchUpdater?.({ view: 'forensics' })).toEqual({ view: undefined });
  });
});
