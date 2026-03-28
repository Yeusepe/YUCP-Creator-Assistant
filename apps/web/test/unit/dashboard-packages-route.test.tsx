import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentPropsWithoutRef, PropsWithChildren, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockLinkProps = ComponentPropsWithoutRef<'a'> & {
  children?: ReactNode;
  search?: unknown;
  to?: unknown;
};

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, search: _search, to: _to, ...props }: MockLinkProps) => (
    <a {...props}>{children}</a>
  ),
  createFileRoute: () => (options: unknown) => ({ options }),
}));

vi.mock('@/components/ui/Toast', () => ({
  useToast: vi.fn(() => ({
    error: vi.fn(),
    success: vi.fn(),
  })),
}));

vi.mock('@/hooks/useActiveDashboardContext', () => ({
  useActiveDashboardContext: vi.fn(() => ({
    activeGuildId: undefined,
    activeTenantId: 'creator-auth-user',
    isPersonalDashboard: true,
    selectedGuild: undefined,
    viewer: { authUserId: 'creator-auth-user' },
  })),
}));

vi.mock('@/hooks/useDashboardSession', () => ({
  useDashboardSession: vi.fn(() => ({
    canRunPanelQueries: true,
    isAuthResolved: true,
    markSessionExpired: vi.fn(),
    status: 'active',
  })),
  isDashboardAuthError: vi.fn(() => false),
}));

vi.mock('@/lib/packages', () => ({
  archiveCreatorPackage: vi.fn(),
  deleteCreatorPackage: vi.fn(),
  listCreatorPackages: vi.fn(),
  renameCreatorPackage: vi.fn(),
  restoreCreatorPackage: vi.fn(),
}));

import * as packagesApi from '@/lib/packages';
import { Route as PackagesRoute } from '@/routes/_authenticated/dashboard/packages';

const archiveCreatorPackageMock = packagesApi.archiveCreatorPackage as ReturnType<typeof vi.fn>;
const listCreatorPackagesMock = packagesApi.listCreatorPackages as ReturnType<typeof vi.fn>;
const renameCreatorPackageMock = packagesApi.renameCreatorPackage as ReturnType<typeof vi.fn>;

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

describe('dashboard packages route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listCreatorPackagesMock.mockResolvedValue({
      packages: [
        {
          packageId: 'pkg.creator.bundle',
          packageName: 'Creator Bundle',
          registeredAt: 1_710_000_000_000,
          updatedAt: 1_710_000_100_000,
          status: 'active',
          archivedAt: undefined,
          canDelete: false,
          deleteBlockedReason: 'Package has signing or license history and cannot be deleted.',
          canArchive: true,
          canRestore: false,
        },
        {
          packageId: 'pkg.creator.legacy',
          packageName: 'Legacy Bundle',
          registeredAt: 1_709_000_000_000,
          updatedAt: 1_709_000_100_000,
          status: 'archived',
          archivedAt: 1_710_500_000_000,
          canDelete: false,
          deleteBlockedReason: 'Archived packages keep their audit history.',
          canArchive: false,
          canRestore: true,
        },
      ],
    });
    renameCreatorPackageMock.mockResolvedValue({
      updated: true,
      packageId: 'pkg.creator.bundle',
      packageName: 'Creator Bundle+',
    });
    archiveCreatorPackageMock.mockResolvedValue({
      archived: true,
      packageId: 'pkg.creator.bundle',
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders package names with package ids as secondary metadata', async () => {
    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByDisplayValue('Creator Bundle')).toBeInTheDocument());
    expect(screen.getByText('pkg.creator.bundle')).toBeInTheDocument();
  });

  it('renames a package from the dashboard manager', async () => {
    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByDisplayValue('Creator Bundle')).toBeInTheDocument());
    const input = screen.getByDisplayValue('Creator Bundle');
    fireEvent.change(input, { target: { value: 'Creator Bundle+' } });
    fireEvent.click(screen.getByRole('button', { name: /save name/i }));

    await waitFor(() =>
      expect(renameCreatorPackageMock.mock.calls[0]?.[0]).toEqual({
        packageId: 'pkg.creator.bundle',
        packageName: 'Creator Bundle+',
      })
    );
  });

  it('disables delete when the package has historical records and explains why', async () => {
    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByDisplayValue('Creator Bundle')).toBeInTheDocument());
    const activeRow = screen.getByDisplayValue('Creator Bundle').closest('.account-list-row');
    if (!(activeRow instanceof HTMLElement)) {
      throw new Error('Active package row was not rendered');
    }

    const deleteButton = within(activeRow).getByRole('button', { name: /delete/i });
    expect(deleteButton).toBeDisabled();
    expect(
      screen.getByText('Package has signing or license history and cannot be deleted.')
    ).toBeInTheDocument();
  });

  it('keeps archived packages collapsed until the submenu is expanded', async () => {
    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(listCreatorPackagesMock).toHaveBeenCalledWith({ includeArchived: true })
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /archived packages \(1\)/i })).toBeInTheDocument()
    );
    expect(screen.queryByDisplayValue('Legacy Bundle')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /archived packages \(1\)/i }));

    expect(screen.getByDisplayValue('Legacy Bundle')).toBeDisabled();
    expect(screen.getByRole('button', { name: /restore/i })).toBeInTheDocument();
  });

  it('updates the archived submenu count immediately after archiving', async () => {
    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByDisplayValue('Creator Bundle')).toBeInTheDocument());
    const activeRow = screen.getByDisplayValue('Creator Bundle').closest('.account-list-row');
    if (!(activeRow instanceof HTMLElement)) {
      throw new Error('Active package row was not rendered');
    }

    fireEvent.click(within(activeRow).getByRole('button', { name: /archive/i }));

    await waitFor(() =>
      expect(archiveCreatorPackageMock.mock.calls[0]?.[0]).toEqual({
        packageId: 'pkg.creator.bundle',
      })
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /archived packages \(2\)/i })).toBeInTheDocument()
    );
  });
});
