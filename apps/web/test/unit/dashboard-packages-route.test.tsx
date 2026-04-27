import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentPropsWithoutRef, PropsWithChildren, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BILLING_CAPABILITY_KEYS } from '../../../../convex/lib/billingCapabilities';

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

vi.mock('@heroui/react', () => {
  const Div = ({
    children,
    isDisabled: _isDisabled,
    isIconOnly: _isIconOnly,
    selectedKey: _selectedKey,
    textValue: _textValue,
    onSelectionChange: _onSelectionChange,
    onOpenChange: _onOpenChange,
    onPress: _onPress,
    ...props
  }: PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div>;

  const Button = ({
    children,
    isDisabled,
    isIconOnly: _isIconOnly,
    onPress,
    type = 'button',
    ...props
  }: PropsWithChildren<Record<string, unknown>>) => (
    <button
      type={typeof type === 'string' ? type : 'button'}
      disabled={Boolean(isDisabled)}
      onClick={typeof onPress === 'function' ? () => onPress() : undefined}
      {...props}
    >
      {children}
    </button>
  );

  const Input = ({
    children: _children,
    isDisabled,
    disabled,
    onChange,
    ...props
  }: PropsWithChildren<Record<string, unknown>>) => (
    <input disabled={Boolean(isDisabled ?? disabled)} onChange={onChange as never} {...props} />
  );

  const TextArea = ({
    children,
    isDisabled,
    disabled,
    onChange,
    ...props
  }: PropsWithChildren<Record<string, unknown>>) => (
    <textarea disabled={Boolean(isDisabled ?? disabled)} onChange={onChange as never} {...props}>
      {typeof children === 'string' ? children : undefined}
    </textarea>
  );

  const Chip = ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => (
    <span {...props}>{children}</span>
  );

  const Card = Object.assign(Div, {
    Header: Div,
    Content: Div,
    Footer: Div,
  });

  const ListBox = Object.assign(Div, {
    Item: Div,
    ItemIndicator: Div,
    Section: Div,
  });

  const Select = Object.assign(Div, {
    Trigger: Div,
    Value: Div,
    Indicator: Div,
    Popover: Div,
  });

  const Skeleton = ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => (
    <div {...props}>{children}</div>
  );

  const Tooltip = Object.assign(({ children }: PropsWithChildren) => <>{children}</>, {
    Content: Div,
  });

  return {
    Button,
    Card,
    Chip,
    ListBox,
    Select,
    Skeleton,
    TextArea,
    Tooltip,
    Input,
  };
});

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
    onSelect,
    onOpenChange: _onOpenChange,
    onPress: _onPress,
    ...props
  }: PropsWithChildren<Record<string, unknown>>) => (
    <input
      {...props}
      onChange={(event) => {
        if (typeof onSelect === 'function') {
          onSelect((event.target as HTMLInputElement).files);
        }
      }}
    />
  );

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

vi.mock('@/lib/certificates', () => ({
  hasActiveCreatorBillingCapability: vi.fn(
    (
      capabilities: Array<{ capabilityKey: string; status: string }> | undefined,
      capabilityKey: string
    ) =>
      capabilities?.some(
        (capability) =>
          capability.capabilityKey === capabilityKey &&
          (capability.status === 'active' || capability.status === 'grace')
      ) ?? false
  ),
  listCreatorCertificates: vi.fn(),
}));

vi.mock('@/lib/packages', () => ({
  archiveCreatorPackage: vi.fn(),
  archiveCreatorBackstageRelease: vi.fn(),
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

import { buildProductLanes } from '@/components/dashboard/PackageRegistryPanel';
import * as certificateApi from '@/lib/certificates';
import * as packagesApi from '@/lib/packages';
import { Route as PackagesRoute } from '@/routes/_authenticated/dashboard/packages.lazy';

const listCreatorCertificatesMock = certificateApi.listCreatorCertificates as ReturnType<
  typeof vi.fn
>;
const listCreatorBackstageProductsMock = packagesApi.listCreatorBackstageProducts as ReturnType<
  typeof vi.fn
>;
const listCreatorPackagesMock = packagesApi.listCreatorPackages as ReturnType<typeof vi.fn>;
const renameCreatorPackageMock = packagesApi.renameCreatorPackage as ReturnType<typeof vi.fn>;
const archiveCreatorBackstageReleaseMock = packagesApi.archiveCreatorBackstageRelease as ReturnType<
  typeof vi.fn
>;
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
    listCreatorCertificatesMock.mockResolvedValue({
      workspaceKey: 'creator-profile:profile-1',
      creatorProfileId: 'profile-1',
      billing: {
        billingEnabled: true,
        status: 'active',
        allowEnrollment: true,
        allowSigning: true,
        planKey: 'creator-suite',
        productId: 'prod_creator_suite',
        deviceCap: 5,
        activeDeviceCount: 1,
        signQuotaPerPeriod: null,
        auditRetentionDays: 90,
        supportTier: 'premium',
        currentPeriodEnd: null,
        graceUntil: null,
        reason: null,
        capabilities: [
          {
            capabilityKey: BILLING_CAPABILITY_KEYS.vpmRepo,
            status: 'active',
          },
        ],
      },
      devices: [],
      availablePlans: [],
      meters: [],
    });
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
          catalogTiers: [
            {
              catalogTierId: 'tier_gold',
              catalogProductId: 'product_1',
              provider: 'gumroad',
              providerTierRef:
                'gumroad|product|17:gumroad-product-1|variant|4:tier|option|4:gold|recurrence|7:monthly',
              displayName: 'Gold Monthly',
              description: 'Monthly supporter tier',
              amountCents: 1200,
              currency: 'USD',
              status: 'active',
              createdAt: 1_710_000_000_000,
              updatedAt: 1_710_000_000_000,
            },
            {
              catalogTierId: 'tier_platinum',
              catalogProductId: 'product_1',
              provider: 'gumroad',
              providerTierRef:
                'gumroad|product|17:gumroad-product-1|variant|8:platinum|recurrence|7:monthly',
              displayName: 'Platinum Monthly',
              description: 'Higher supporter tier',
              amountCents: 2400,
              currency: 'USD',
              status: 'active',
              createdAt: 1_710_000_000_000,
              updatedAt: 1_710_000_000_000,
            },
          ],
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
                deliveryPackageReleaseId: 'release_current',
                version: '1.2.3',
                channel: 'stable',
                releaseStatus: 'published',
                repositoryVisibility: 'listed',
                artifactKey: 'artifact:creator-bundle',
                contentType: 'application/zip',
                createdAt: 1_710_000_000_000,
                deliveryName: 'creator-bundle-1.2.3.zip',
                metadata: { source: 'unitypackage' },
                publishedAt: 1_710_000_100_000,
                unityVersion: '2022.3',
                updatedAt: 1_710_000_100_000,
                zipSha256: 'a'.repeat(64),
              },
              releases: [
                {
                  deliveryPackageReleaseId: 'release_current',
                  version: '1.2.3',
                  channel: 'stable',
                  releaseStatus: 'published',
                  repositoryVisibility: 'listed',
                  artifactKey: 'artifact:creator-bundle',
                  contentType: 'application/zip',
                  createdAt: 1_710_000_000_000,
                  deliveryName: 'creator-bundle-1.2.3.zip',
                  metadata: { source: 'unitypackage' },
                  publishedAt: 1_710_000_100_000,
                  unityVersion: '2022.3',
                  updatedAt: 1_710_000_100_000,
                  zipSha256: 'a'.repeat(64),
                },
                {
                  deliveryPackageReleaseId: 'release_old',
                  version: '1.2.2',
                  channel: 'stable',
                  releaseStatus: 'superseded',
                  repositoryVisibility: 'hidden',
                  artifactKey: 'artifact:creator-bundle-older',
                  contentType: 'application/zip',
                  createdAt: 1_709_000_000_000,
                  deliveryName: 'creator-bundle-1.2.2.zip',
                  metadata: { source: 'zip' },
                  publishedAt: 1_709_000_100_000,
                  unityVersion: '2022.3',
                  updatedAt: 1_709_000_100_000,
                  zipSha256: 'b'.repeat(64),
                },
              ],
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
          catalogTiers: [],
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
          catalogTiers: [],
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
    archiveCreatorBackstageReleaseMock.mockResolvedValue({
      archived: true,
      deliveryPackageReleaseId: 'release_old',
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

    await waitFor(() =>
      expect(screen.getByText(/Install ID:\s*pkg\.creator\.bundle/i)).toBeInTheDocument()
    );
    expect(
      screen.getByText(/customers should start from your YUCP access link/i)
    ).toBeInTheDocument();
    expect(screen.getAllByText('Creator Bundle Product').length).toBeGreaterThan(0);
    expect(screen.getByText(/Mapache/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open in vcc/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upload a package/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^upload$/i }).length).toBeGreaterThan(0);
    expect(screen.getByText('pkg.creator.bundle')).toBeInTheDocument();
    expect(
      document.querySelector('img[src="https://public-files.gumroad.com/creator-bundle.png"]')
    ).not.toBeNull();
    expect(
      document.querySelector('img[src="https://public-files.gumroad.com/creator-bundle.png"]')
    ).toHaveAttribute('src', 'https://public-files.gumroad.com/creator-bundle.png');
  });

  it('aggregates active subscription tiers into a product lane for package setup', () => {
    const lanes = buildProductLanes([
      {
        aliases: ['Creator Bundle Product'],
        catalogTiers: [
          {
            catalogTierId: 'tier_gold',
            catalogProductId: 'product_1',
            provider: 'gumroad',
            providerTierRef: 'gumroad-tier-gold',
            displayName: 'Gold Monthly',
            description: 'Monthly supporter tier',
            amountCents: 1200,
            currency: 'USD',
            status: 'active',
            createdAt: 1,
            updatedAt: 1,
          },
          {
            catalogTierId: 'tier_legacy',
            catalogProductId: 'product_1',
            provider: 'gumroad',
            providerTierRef: 'gumroad-tier-legacy',
            displayName: 'Legacy Tier',
            status: 'archived',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        backstagePackages: [],
        canonicalSlug: 'creator-bundle',
        catalogProductId: 'product_1',
        displayName: 'Creator Bundle Product',
        productId: 'gumroad-product-1',
        provider: 'gumroad',
        providerProductRef: 'gumroad-product-1',
        status: 'active',
        supportsAutoDiscovery: true,
        updatedAt: 1,
        canArchive: true,
        canRestore: false,
        canDelete: false,
      },
      {
        aliases: ['Creator Bundle Product'],
        catalogTiers: [
          {
            catalogTierId: 'tier_platinum',
            catalogProductId: 'product_2',
            provider: 'patreon',
            providerTierRef: 'patreon-tier-platinum',
            displayName: 'Platinum Monthly',
            description: 'Higher supporter tier',
            amountCents: 2400,
            currency: 'USD',
            status: 'active',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        backstagePackages: [],
        canonicalSlug: 'creator-bundle',
        catalogProductId: 'product_2',
        displayName: 'Creator Bundle Product',
        productId: 'patreon-campaign-1',
        provider: 'patreon',
        providerProductRef: 'patreon-campaign-1',
        status: 'active',
        supportsAutoDiscovery: true,
        updatedAt: 1,
        canArchive: true,
        canRestore: false,
        canDelete: true,
      },
    ]);

    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.catalogTiers.map((tier) => tier.catalogTierId)).toEqual([
      'tier_gold',
      'tier_platinum',
    ]);
  });

  it('keeps first-upload products behind the upload button instead of a separate setup section', async () => {
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
                deliveryPackageReleaseId: 'release_current',
                version: '1.2.3',
                channel: 'stable',
                releaseStatus: 'published',
                repositoryVisibility: 'listed',
                artifactKey: 'artifact:creator-bundle',
                contentType: 'application/zip',
                createdAt: 1_710_000_000_000,
                deliveryName: 'creator-bundle-1.2.3.zip',
                metadata: { source: 'unitypackage' },
                publishedAt: 1_710_000_100_000,
                unityVersion: '2022.3',
                updatedAt: 1_710_000_100_000,
                zipSha256: 'a'.repeat(64),
              },
              releases: [],
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
          deleteBlockedReason: 'Product has package history.',
        },
        {
          aliases: ['Song Thing'],
          backstagePackages: [],
          canonicalSlug: 'song-thing',
          catalogProductId: 'song_gumroad',
          displayName: 'Song Thing',
          thumbnailUrl: 'https://public-files.gumroad.com/song-thing.png',
          productId: 'gumroad-song-thing',
          provider: 'gumroad',
          providerProductRef: 'gumroad-song-thing',
          status: 'active',
          supportsAutoDiscovery: true,
          updatedAt: 1_710_000_200_000,
          canArchive: true,
          canRestore: false,
          canDelete: true,
        },
        {
          aliases: ['Song Thing'],
          backstagePackages: [],
          canonicalSlug: 'song-thing',
          catalogProductId: 'song_jinxxy',
          displayName: 'Song Thing',
          productId: 'jinxxy-song-thing',
          provider: 'jinxxy',
          providerProductRef: 'jinxxy-song-thing',
          status: 'active',
          supportsAutoDiscovery: false,
          updatedAt: 1_710_000_300_000,
          canArchive: true,
          canRestore: false,
          canDelete: true,
        },
      ],
    });

    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /upload a package/i })).toBeInTheDocument()
    );
    expect(screen.queryByText('Set up a new product')).toBeNull();
    expect(screen.queryByText('Song Thing')).toBeNull();
  });

  it('merges storefront rows when linked package IDs match even if slugs and names drift', async () => {
    listCreatorBackstageProductsMock.mockResolvedValue({
      products: [
        {
          aliases: ['Song'],
          backstagePackages: [
            {
              packageId: 'pkg.song.bundle',
              packageName: 'Song Bundle',
              displayName: 'Song Bundle',
              status: 'active',
              repositoryVisibility: 'listed',
              defaultChannel: 'stable',
              latestPublishedVersion: '2.4.0',
              latestRelease: {
                deliveryPackageReleaseId: 'song_release_current',
                version: '2.4.0',
                channel: 'stable',
                releaseStatus: 'published',
                repositoryVisibility: 'listed',
                artifactKey: 'artifact:song-bundle',
                contentType: 'application/zip',
                createdAt: 1_710_000_000_000,
                deliveryName: 'song-bundle-2.4.0.zip',
                metadata: { source: 'unitypackage' },
                publishedAt: 1_710_000_100_000,
                unityVersion: '2022.3',
                updatedAt: 1_710_000_100_000,
                zipSha256: 'c'.repeat(64),
              },
              releases: [],
            },
          ],
          canonicalSlug: 'song-deluxe-gumroad',
          catalogProductId: 'song_gumroad',
          displayName: 'Song Deluxe',
          thumbnailUrl: 'https://public-files.gumroad.com/song-deluxe.png',
          productId: 'gumroad-song-1',
          provider: 'gumroad',
          providerProductRef: 'gumroad-song-1',
          status: 'active',
          supportsAutoDiscovery: true,
          updatedAt: 1_710_000_100_000,
          canArchive: true,
          canRestore: false,
          canDelete: false,
          deleteBlockedReason: 'Product has package history.',
        },
        {
          aliases: ['Song'],
          backstagePackages: [
            {
              packageId: 'pkg.song.bundle',
              packageName: 'Song Bundle',
              displayName: 'Song Bundle',
              status: 'active',
              repositoryVisibility: 'listed',
              defaultChannel: 'stable',
              latestPublishedVersion: '2.4.0',
              latestRelease: {
                deliveryPackageReleaseId: 'song_release_current',
                version: '2.4.0',
                channel: 'stable',
                releaseStatus: 'published',
                repositoryVisibility: 'listed',
                artifactKey: 'artifact:song-bundle',
                contentType: 'application/zip',
                createdAt: 1_710_000_000_000,
                deliveryName: 'song-bundle-2.4.0.zip',
                metadata: { source: 'unitypackage' },
                publishedAt: 1_710_000_100_000,
                unityVersion: '2022.3',
                updatedAt: 1_710_000_100_000,
                zipSha256: 'c'.repeat(64),
              },
              releases: [],
            },
          ],
          canonicalSlug: 'song-deluxe-jinxxy',
          catalogProductId: 'song_jinxxy',
          displayName: 'Song: Deluxe Edition',
          productId: 'jinxxy-song-1',
          provider: 'jinxxy',
          providerProductRef: 'jinxxy-song-1',
          status: 'active',
          supportsAutoDiscovery: true,
          updatedAt: 1_710_000_100_000,
          canArchive: true,
          canRestore: false,
          canDelete: true,
        },
      ],
    });

    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(
        screen.getByText(/Install ID:\s*pkg\.song\.bundle\s+·\s+Live version 2\.4\.0/i)
      ).toBeInTheDocument()
    );
    expect(screen.getAllByText(/Song/i).length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.pm-product-row')).toHaveLength(1);
    expect(
      document.querySelector('img[src="https://public-files.gumroad.com/song-deluxe.png"]')
    ).not.toBeNull();
  });

  it('merges storefront rows through shared aliases even when canonical slugs differ', async () => {
    const lanes = buildProductLanes([
      {
        aliases: ['Song'],
        backstagePackages: [],
        canonicalSlug: 'gumroad-song-release',
        catalogProductId: 'song_alias_gumroad',
        displayName: 'Song Release',
        productId: 'gumroad-song-alias',
        provider: 'gumroad',
        providerProductRef: 'gumroad-song-alias',
        status: 'active',
        supportsAutoDiscovery: true,
        updatedAt: 1_710_000_100_000,
        canArchive: true,
        canRestore: false,
        canDelete: true,
      },
      {
        aliases: ['Song'],
        backstagePackages: [],
        canonicalSlug: 'patreon-song-membership',
        catalogProductId: 'song_alias_patreon',
        displayName: 'Song Members Tier',
        productId: 'patreon-song-alias',
        provider: 'patreon',
        providerProductRef: 'patreon-song-alias',
        status: 'active',
        supportsAutoDiscovery: true,
        updatedAt: 1_710_000_100_000,
        canArchive: true,
        canRestore: false,
        canDelete: true,
      },
    ]);

    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.products).toHaveLength(2);
    expect(lanes[0]?.providerLabels).toEqual(['Gumroad', 'Patreon']);
  });

  it('shows the Polar upgrade gate when the custom VPM repo entitlement is missing', async () => {
    listCreatorCertificatesMock.mockResolvedValue({
      workspaceKey: 'creator-profile:profile-1',
      creatorProfileId: 'profile-1',
      billing: {
        billingEnabled: true,
        status: 'inactive',
        allowEnrollment: false,
        allowSigning: false,
        planKey: null,
        productId: null,
        deviceCap: null,
        activeDeviceCount: 0,
        signQuotaPerPeriod: null,
        auditRetentionDays: null,
        supportTier: null,
        currentPeriodEnd: null,
        graceUntil: null,
        reason: 'Certificate subscription required',
        capabilities: [],
      },
      devices: [],
      availablePlans: [],
      meters: [],
    });

    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('Custom VPM repo required')).toBeInTheDocument());
    expect(screen.getByText('Upgrade billing')).toBeInTheDocument();
    expect(listCreatorPackagesMock).not.toHaveBeenCalled();
  });

  it('opens a product link and shows previous uploads', async () => {
    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(screen.getByText(/Install ID:\s*pkg\.creator\.bundle/i)).toBeInTheDocument()
    );
    fireEvent.click(
      screen.getByRole('button', { name: /open past uploads for creator bundle product/i })
    );

    expect(screen.getByText('Past uploads')).toBeInTheDocument();
    expect(screen.getByText('creator-bundle-1.2.3.zip')).toBeInTheDocument();
    expect(screen.getByText('creator-bundle-1.2.2.zip')).toBeInTheDocument();
    expect(screen.getByText(/SHA-256 a{64}/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /copy install id/i }).length).toBeGreaterThan(0);
  });

  it('archives an old upload from the past uploads sheet', async () => {
    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(screen.getByText(/Install ID:\s*pkg\.creator\.bundle/i)).toBeInTheDocument()
    );
    fireEvent.click(
      screen.getByRole('button', { name: /open past uploads for creator bundle product/i })
    );

    fireEvent.click(screen.getByRole('button', { name: /archive upload/i }));

    await waitFor(() =>
      expect(archiveCreatorBackstageReleaseMock).toHaveBeenCalledWith({
        packageId: 'pkg.creator.bundle',
        deliveryPackageReleaseId: 'release_old',
      })
    );
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
    await screen.findByText('Hidden install IDs');
    const hiddenPackagesDetails = screen.getByText('Hidden install IDs').closest('details');
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
    const mergedProductLane = screen
      .getByText(/Install ID:\s*pkg\.creator\.bundle/i)
      .closest('.pm-product-row');
    expect(mergedProductLane).not.toBeNull();
    fireEvent.click(
      within(mergedProductLane as HTMLElement).getByRole('button', {
        name: /open past uploads for creator bundle product/i,
      })
    );
    fireEvent.click(screen.getByRole('button', { name: /hide link/i }));

    await waitFor(() =>
      expect(archiveCreatorBackstageProductMock).toHaveBeenCalledWith({
        catalogProductId: 'product_1',
      })
    );
  });
});
