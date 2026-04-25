import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  createLazyFileRoute: () => (options: unknown) => ({ options }),
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

vi.mock('@heroui-pro/react', () => {
  const Div = ({
    children,
    isDisabled: _isDisabled,
    isOpen: _isOpen,
    onOpenChange: _onOpenChange,
    onPress: _onPress,
    ...props
  }: PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div>;
  const Input = ({
    children: _children,
    isDisabled: _isDisabled,
    onOpenChange: _onOpenChange,
    onPress: _onPress,
    ...props
  }: PropsWithChildren<Record<string, unknown>>) => <input {...props} />;

  const DropZone = Object.assign(Div, {
    Area: Div,
    Description: Div,
    FileFormatIcon: Div,
    FileInfo: Div,
    FileItem: Div,
    FileList: Div,
    FileMeta: Div,
    FileName: Div,
    FileProgress: Div,
    FileProgressFill: Div,
    FileProgressTrack: Div,
    FileRemoveTrigger: Div,
    Icon: Div,
    Input,
    Label: Div,
    Trigger: Div,
  });

  const EmptyState = Object.assign(Div, {
    Content: Div,
    Description: Div,
    Header: Div,
    Media: Div,
    Title: Div,
  });

  const ItemCard = Object.assign(Div, {
    Action: Div,
    Content: Div,
    Description: Div,
    Icon: Div,
    Title: Div,
  });

  const Sheet = Object.assign(Div, {
    Backdrop: Div,
    Body: Div,
    Close: Div,
    CloseTrigger: Div,
    Content: Div,
    Dialog: Div,
    Footer: Div,
    Handle: Div,
    Header: Div,
    Heading: Div,
  });

  return {
    DropZone,
    EmptyState,
    ItemCard,
    Sheet,
  };
});

vi.mock('@/lib/packages', () => ({
  archiveCreatorPackage: vi.fn(),
  archiveCreatorBackstageProduct: vi.fn(),
  createBackstageReleaseUploadUrl: vi.fn(),
  listCreatorBackstageProducts: vi.fn(),
  listCreatorPackages: vi.fn(),
  publishBackstageRelease: vi.fn(),
  renameCreatorPackage: vi.fn(),
  requestBackstageRepoAccess: vi.fn(),
  restoreCreatorBackstageProduct: vi.fn(),
  restoreCreatorPackage: vi.fn(),
  uploadBackstageReleaseFile: vi.fn(),
}));

import * as packagesApi from '@/lib/packages';
import { Route as PackagesRoute } from '@/routes/_authenticated/dashboard/packages.lazy';

const listCreatorBackstageProductsMock = packagesApi.listCreatorBackstageProducts as ReturnType<
  typeof vi.fn
>;
const listCreatorPackagesMock = packagesApi.listCreatorPackages as ReturnType<typeof vi.fn>;
const renameCreatorPackageMock = packagesApi.renameCreatorPackage as ReturnType<typeof vi.fn>;
const archiveCreatorBackstageProductMock = packagesApi.archiveCreatorBackstageProduct as ReturnType<
  typeof vi.fn
>;
const requestBackstageRepoAccessMock = packagesApi.requestBackstageRepoAccess as ReturnType<
  typeof vi.fn
>;

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
    listCreatorBackstageProductsMock.mockResolvedValue({
      products: [
        {
          aliases: ['Creator Bundle Product'],
          backstagePackages: [
            {
              packageId: 'pkg.creator.bundle',
              packageName: 'Creator Bundle',
              displayName: 'Creator Bundle',
              status: 'active',
              repositoryVisibility: 'listed',
              defaultChannel: 'stable',
              latestPublishedVersion: '1.2.3',
              latestRelease: {
                version: '1.2.3',
                channel: 'stable',
                releaseStatus: 'published',
                repositoryVisibility: 'listed',
                artifactKey: 'artifact:creator-bundle',
                publishedAt: 1_710_000_100_000,
              },
            },
          ],
          canonicalSlug: 'creator-bundle',
          catalogProductId: 'product_1',
          displayName: 'Creator Bundle Product',
          thumbnailUrl: 'https://public-files.gumroad.com/creator-bundle.png',
          productId: 'gumroad-product-1',
          provider: 'gumroad',
          providerProductRef: 'gumroad-product-1',
          status: 'active',
          supportsAutoDiscovery: true,
          updatedAt: 1_710_000_100_000,
          canArchive: true,
          canRestore: false,
          canDelete: false,
          deleteBlockedReason: 'Product has package, role, entitlement, or tier history.',
        },
        {
          aliases: ['Creator Bundle Product'],
          backstagePackages: [],
          canonicalSlug: 'creator-bundle',
          catalogProductId: 'product_2',
          displayName: 'Creator Bundle Product',
          productId: 'jinxxy-product-1',
          provider: 'jinxxy',
          providerProductRef: 'jinxxy-product-1',
          status: 'active',
          supportsAutoDiscovery: true,
          updatedAt: 1_710_000_100_000,
          canArchive: true,
          canRestore: false,
          canDelete: true,
        },
        {
          aliases: ['Old Creator Product'],
          backstagePackages: [],
          canonicalSlug: 'old-creator-product',
          catalogProductId: 'product_hidden',
          displayName: 'Old Creator Product',
          productId: 'gumroad-product-hidden',
          provider: 'gumroad',
          providerProductRef: 'gumroad-product-hidden',
          status: 'archived',
          supportsAutoDiscovery: true,
          updatedAt: 1_709_000_100_000,
          canArchive: false,
          canRestore: true,
          canDelete: true,
        },
      ],
    });
    requestBackstageRepoAccessMock.mockResolvedValue({
      creatorName: 'Mapache',
      creatorRepoRef: 'mapache',
      repositoryUrl: 'https://api.test/v1/backstage/repos/mapache/index.json',
      repositoryName: 'Mapache repo',
      addRepoUrl:
        'vcc://vpm/addRepo?url=https%3A%2F%2Fapi.test%2Fv1%2Fbackstage%2Frepos%2Fmapache%2Findex.json',
      repoTokenHeader: 'X-YUCP-Repo-Token',
      repoToken: 'ybt_example',
      expiresAt: 1_710_000_100_000,
    });
    renameCreatorPackageMock.mockResolvedValue({
      updated: true,
      packageId: 'pkg.creator.bundle',
      packageName: 'Creator Bundle+',
    });
    archiveCreatorBackstageProductMock.mockResolvedValue({
      archived: true,
      catalogProductId: 'product_1',
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders repo access and product-linked release lanes', async () => {
    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('2 storefronts')).toBeInTheDocument());
    expect(screen.getAllByText('Creator Bundle Product').length).toBeGreaterThan(0);
    expect(screen.getByText('Mapache')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open in vcc/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /upload package/i }).length).toBeGreaterThan(0);
    expect(screen.getByText('pkg.creator.bundle')).toBeInTheDocument();
    expect(screen.getByText('Drop a Unity package here')).toBeInTheDocument();
    expect(document.querySelector('input[accept*=".unitypackage"]')).not.toBeNull();
    expect(
      document.querySelector('img[src="https://public-files.gumroad.com/creator-bundle.png"]')
    ).not.toBeNull();
    expect(
      document.querySelector('img[src="https://public-files.gumroad.com/creator-bundle.png"]')
    ).toHaveAttribute('src', 'https://public-files.gumroad.com/creator-bundle.png');
  });

  it('renames a package from the dashboard manager', async () => {
    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('pkg.creator.bundle')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /rename/i }));
    const input = screen.getByDisplayValue('Creator Bundle');
    fireEvent.change(input, { target: { value: 'Creator Bundle+' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(renameCreatorPackageMock.mock.calls[0]?.[0]).toEqual({
        packageId: 'pkg.creator.bundle',
        packageName: 'Creator Bundle+',
      })
    );
  });

  it('does not surface delete controls on the packages dashboard', async () => {
    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('pkg.creator.bundle')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
    expect(screen.queryByText('Delete locked')).toBeNull();
  });

  it('keeps hidden packages collapsed by default when archived entries exist', async () => {
    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(listCreatorPackagesMock).toHaveBeenCalledWith({ includeArchived: true })
    );
    await screen.findByText('Hidden packages');
    const hiddenPackagesDetails = screen.getByText('Hidden packages').closest('details');
    expect(hiddenPackagesDetails?.open).toBe(false);
  });

  it('keeps hidden product links collapsed by default and lets visible links be hidden', async () => {
    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await screen.findByText('Hidden product links');
    const hiddenProductsDetails = screen.getByText('Hidden product links').closest('details');
    expect(hiddenProductsDetails?.open).toBe(false);
    fireEvent.click(screen.getAllByRole('button', { name: /^hide$/i })[0]);

    await waitFor(() =>
      expect(archiveCreatorBackstageProductMock.mock.calls[0]?.[0]).toEqual({
        catalogProductId: 'product_1',
      })
    );
  });
});
