import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  apiBlobMock,
  apiDeleteMock,
  apiGetMock,
  apiPostMock,
  apiPutMock,
  markSessionExpiredMock,
  navigateMock,
  routeSearchMock,
  toastErrorMock,
  toastSuccessMock,
  uploadStartMock,
  uploadErrorRef,
  uploadProgressRef,
  uploadSuccessRef,
} = vi.hoisted(() => ({
  apiBlobMock: vi.fn(),
  apiDeleteMock: vi.fn(),
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  apiPutMock: vi.fn(),
  markSessionExpiredMock: vi.fn(),
  navigateMock: vi.fn(),
  routeSearchMock: vi.fn(() => ({ view: undefined })),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  uploadStartMock: vi.fn(),
  uploadErrorRef: { current: null as null | ((error: Error) => void) },
  uploadProgressRef: { current: null as null | ((uploaded: number, total: number) => void) },
  uploadSuccessRef: { current: null as null | (() => void) },
}));

vi.mock('@tanstack/react-router', () => ({
  createLazyFileRoute: () => (options: unknown) => ({
    options,
    useSearch: routeSearchMock,
  }),
  Link: ({ children, className }: PropsWithChildren<{ className?: string }>) => (
    <a className={className} href="/dashboard/packages">
      {children}
    </a>
  ),
  useNavigate: () => navigateMock,
}));

vi.mock('@/api/client', () => ({
  apiClient: {
    blob: apiBlobMock,
    delete: apiDeleteMock,
    get: apiGetMock,
    post: apiPostMock,
    put: apiPutMock,
  },
}));

vi.mock('@/hooks/useCreatorCertificateWorkspace', () => ({
  useCreatorCertificateWorkspace: () => ({
    billing: { capabilities: [{ capabilityKey: 'vpm_repo', status: 'active' }] },
    hasAuthError: false,
    isLoading: false,
    query: { isError: false, isFetching: false, refetch: vi.fn() },
  }),
}));

vi.mock('@/hooks/useDashboardSession', () => ({
  isDashboardAuthError: (error: unknown) =>
    error instanceof Error && /authentication required/i.test(error.message),
  useDashboardSession: () => ({
    canRunPanelQueries: true,
    markSessionExpired: markSessionExpiredMock,
  }),
}));

vi.mock('@/lib/certificates', () => ({
  hasActiveCreatorBillingCapability: () => true,
}));

vi.mock('@/lib/account', () => ({
  getAccountProviderIconPath: () => '/Icons/Store.png',
}));

vi.mock('@/components/dashboard/CouplingForensicsPanel', () => ({
  CouplingForensicsPanel: () => <div>Forensics workspace</div>,
}));

vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({
    error: toastErrorMock,
    info: vi.fn(),
    success: toastSuccessMock,
    warning: vi.fn(),
  }),
}));

vi.mock('@/lib/hyperdx', () => ({
  startHyperdxBrowserSpan: () => ({ end: vi.fn(), fail: vi.fn() }),
}));

vi.mock('tus-js-client', () => ({
  Upload: class {
    private readonly options: {
      onError?: (error: Error) => void;
      onProgress?: (uploaded: number, total: number) => void;
      onSuccess?: () => void;
    };

    constructor(
      _file: File,
      options: {
        onError?: (error: Error) => void;
        onProgress?: (uploaded: number, total: number) => void;
        onSuccess?: () => void;
      }
    ) {
      this.options = options;
    }

    findPreviousUploads = async () => [];
    resumeFromPreviousUpload = () => undefined;
    start = () => {
      uploadStartMock();
      this.options.onProgress?.(50, 100);
      uploadProgressRef.current = (uploaded, total) => this.options.onProgress?.(uploaded, total);
      uploadErrorRef.current = (error) => this.options.onError?.(error);
      uploadSuccessRef.current = () => this.options.onSuccess?.();
    };
  },
}));

import { Route as DashboardPackagesRoute } from '@/routes/_authenticated/dashboard/packages.lazy';

const product = {
  _id: 'catalog_product_1',
  aliases: ['avatar-bundle'],
  canonicalSlug: 'avatar-bundle',
  catalogProductIds: ['catalog_product_1'],
  catalogTiers: [
    {
      _id: 'catalog_tier_commercial',
      catalogProductId: 'catalog_product_1',
      createdAt: 1,
      displayName: 'Commercial buyers',
      provider: 'gumroad',
      providerTierRef: 'commercial',
      status: 'active',
      updatedAt: 2,
    },
  ],
  displayName: 'Avatar Bundle',
  packageId: 'com.creator.avatar-bundle',
  packageName: 'Avatar Bundle',
  publicCreatorSlug: 'mapache',
  publicSlug: 'avatar-bundle',
  packageEditions: [
    {
      catalogProductIds: ['catalog_product_1'],
      catalogTierIds: ['catalog_tier_commercial'],
      createdAt: 1,
      displayName: 'Commercial',
      editionId: 'commercial',
      priority: 100,
      status: 'active',
      updatedAt: 2,
    },
  ],
  productId: 'gumroad-avatar-bundle',
  provider: 'gumroad',
  providerProductRef: 'store-ref-1',
  status: 'active',
  supportsAutoDiscovery: true,
  createdAt: 1,
  updatedAt: 2,
  canArchive: true,
  canRestore: false,
  canDelete: true,
};

const standardVersionPath =
  '/api/creator/packages/by-package/com.creator.avatar-bundle/editions/standard/versions';
const acceptedUploadLaneStorageKey = 'yucp.package-upload.accepted-lane.v1';
const versionStatusPath = (versionId: string) => `${standardVersionPath}/${versionId}/status`;

const exactLabelVersion = {
  createdAt: '2026-07-26T12:00:00.000Z',
  editionId: 'standard',
  packageId: 'com.creator.avatar-bundle',
  state: 'ready',
  updatedAt: '2026-07-26T12:05:00.000Z',
  version: 'Summer launch / Wave A',
  versionId: 'version-summer-launch',
};

const firstUploadProduct = {
  ...product,
  _id: 'catalog_product_first_upload',
  aliases: ['First Upload Product'],
  canonicalSlug: 'first-upload-product',
  displayName: 'First Upload Product',
  packageId: undefined,
  productId: 'first-upload-product',
  providerProductRef: 'first-upload-ref',
};

const collaboratorProduct = {
  ...firstUploadProduct,
  _id: 'catalog_product_collaborator',
  accessRole: 'collaborator' as const,
  canonicalSlug: 'collaborator-product',
  creatorAuthUserId: 'shared-store-owner',
  creatorDisplayName: 'Shared Creator Store',
  displayName: 'Collaborator Product',
  productId: 'collaborator-product',
  provider: 'jinxxy',
  providerProductRef: 'collaborator-product-ref',
};

const duplicateGumroadProduct = {
  ...product,
  _id: 'catalog_product_cross_store_gumroad',
  aliases: ['Cross-store Product'],
  canonicalSlug: 'gumroad-cross-store-product',
  displayName: 'Cross-store Product',
  packageId: 'com.creator.cross-store-product',
  productId: 'gumroad-cross-store-product',
  providerProductRef: 'gumroad-cross-store-ref',
};

const duplicateJinxxyProduct = {
  ...duplicateGumroadProduct,
  _id: 'catalog_product_cross_store_jinxxy',
  canonicalSlug: 'jinxxy-cross-store-product',
  productId: 'jinxxy-cross-store-product',
  provider: 'jinxxy',
  providerProductRef: 'jinxxy-cross-store-ref',
};

const linkedCrossStoreProduct = {
  ...duplicateGumroadProduct,
  catalogProductIds: [duplicateGumroadProduct._id, duplicateJinxxyProduct._id],
  storefronts: [
    {
      catalogProductId: duplicateGumroadProduct._id,
      productId: duplicateGumroadProduct.productId,
      provider: duplicateGumroadProduct.provider,
      providerProductRef: duplicateGumroadProduct.providerProductRef,
    },
    {
      catalogProductId: duplicateJinxxyProduct._id,
      productId: duplicateJinxxyProduct.productId,
      provider: duplicateJinxxyProduct.provider,
      providerProductRef: duplicateJinxxyProduct.providerProductRef,
    },
  ],
};

const sameNameGumroadProduct = {
  ...product,
  _id: 'catalog_product_same_name_a',
  aliases: ['Shared Product Name'],
  canonicalSlug: 'gumroad-shared-product-name',
  displayName: 'Shared Product Name',
  packageId: undefined,
  productId: 'gumroad-shared-product-name',
  providerProductRef: 'gumroad-shared-product-ref',
};

const sameNameJinxxyProduct = {
  ...sameNameGumroadProduct,
  _id: 'catalog_product_same_name_b',
  canonicalSlug: 'jinxxy-shared-product-name',
  packageId: undefined,
  productId: 'jinxxy-shared-product-name',
  provider: 'jinxxy',
  providerProductRef: 'jinxxy-shared-product-ref',
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

async function selectPackageEdition(name: string): Promise<void> {
  fireEvent.click(screen.getByLabelText('Package edition'));
  fireEvent.click(await screen.findByRole('option', { name: new RegExp(name, 'i') }));
}

async function selectReleaseHistoryEdition(name: string): Promise<void> {
  fireEvent.click(screen.getByLabelText('Release history edition'));
  fireEvent.click(await screen.findByRole('option', { name: new RegExp(name, 'i') }));
}

describe('dashboard packages route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    routeSearchMock.mockReturnValue({ view: undefined });
    uploadErrorRef.current = null;
    uploadSuccessRef.current = null;
    apiGetMock.mockImplementation(
      (path: string, options?: { params?: { configured?: string; packageId?: string } }) => {
        if (path === '/api/creator/packages') {
          if (options?.params?.configured === 'false') {
            return Promise.resolve({
              data: [
                product,
                firstUploadProduct,
                linkedCrossStoreProduct,
                sameNameGumroadProduct,
                sameNameJinxxyProduct,
              ],
              hasMore: false,
              nextCursor: null,
            });
          }
          return Promise.resolve({
            data: [product],
            hasMore: false,
            nextCursor: null,
          });
        }
        if (path === '/api/creator/packages/catalog_product_1') {
          return Promise.resolve(product);
        }
        if (path === standardVersionPath) {
          return Promise.resolve({
            data: [exactLabelVersion],
            hasMore: false,
            nextCursor: null,
          });
        }
        if (
          path.match(
            /^\/api\/creator\/packages\/by-package\/[^/]+\/editions\/[^/]+\/versions\/[^/]+\/status$/
          )
        ) {
          return Promise.resolve({
            editionId: 'standard',
            errorCategory: null,
            errorCode: null,
            estimatedStartAt: null,
            packageId: 'com.creator.avatar-bundle',
            queuePosition: null,
            state: 'ready',
            updatedAt: '2026-07-26T12:00:00.000Z',
            version: '2.0.0',
            versionId: path.split('/').at(-2),
          });
        }
        if (path === '/api/creator/packages/by-package/com.creator.avatar-bundle/vcc-link') {
          return Promise.resolve({
            status: 'inactive',
            bootstrapDownloadUrl:
              '/api/creator/packages/by-package/com.creator.avatar-bundle/bootstrap',
            unityPackageDownloadUrl:
              '/api/creator/packages/by-package/com.creator.avatar-bundle/bootstrap.unitypackage',
          });
        }
        return Promise.reject(new Error(`Unexpected GET ${path}`));
      }
    );
    apiPostMock.mockResolvedValue({
      versionId: 'version-2',
      exp: '123',
      sig: 'signature',
      tusEndpoint: 'https://ingest.test/files',
      headers: { 'X-YUCP-Version-Id': 'version-2' },
      catalogProductId: 'catalog_product_1',
      protectionPolicyId: 'supported-visual-assets-v2',
    });
    apiPutMock.mockResolvedValue({ editionId: 'supporter', saved: true });
  });

  afterEach(() => cleanup());

  it('restores product lanes from the current packageRegistry list contract', async () => {
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });

    expect(screen.getByRole('heading', { name: 'Unity Package Library' })).toBeInTheDocument();
    expect(await screen.findByText('Avatar Bundle')).toBeInTheDocument();
    expect(screen.getByText(/ready for updates/i)).toBeInTheDocument();
    expect(
      screen.queryByText(
        'Share the YUCP access page in your store delivery notes. Buyers sign in, verify their purchase, then add the product to VCC.'
      )
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/private repository/i)).not.toBeInTheDocument();
    expect(apiGetMock).toHaveBeenCalledWith('/api/creator/packages', {
      params: { configured: 'true', limit: '50' },
    });
  });

  it('renders one configured product row with every linked storefront', async () => {
    apiGetMock.mockResolvedValue({
      data: [
        {
          ...duplicateGumroadProduct,
          catalogProductIds: [duplicateGumroadProduct._id, duplicateJinxxyProduct._id],
          storefronts: [
            {
              catalogProductId: duplicateGumroadProduct._id,
              productId: duplicateGumroadProduct.productId,
              provider: 'gumroad',
              providerProductRef: duplicateGumroadProduct.providerProductRef,
            },
            {
              catalogProductId: duplicateJinxxyProduct._id,
              productId: duplicateJinxxyProduct.productId,
              provider: 'jinxxy',
              providerProductRef: duplicateJinxxyProduct.providerProductRef,
            },
          ],
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });

    expect(await screen.findAllByText('Cross-store Product')).toHaveLength(1);
    expect(screen.getByText('Gumroad')).toBeInTheDocument();
    expect(screen.getByText('Jinxxy')).toBeInTheDocument();
  });

  it('keeps package summaries free of release history and store references', async () => {
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });

    const productRowButton = await screen.findByRole('button', {
      name: 'Open details for Avatar Bundle',
    });
    expect(productRowButton).toHaveTextContent('Ready for updates');
    expect(productRowButton).not.toHaveTextContent('Summer launch / Wave A');
    expect(productRowButton).not.toHaveTextContent(product.providerProductRef);
    expect(productRowButton).not.toHaveTextContent(product.productId);
  });

  it('lets the creator override the public product path in product details', async () => {
    apiPutMock.mockResolvedValue({
      packageId: 'com.creator.avatar-bundle',
      publicSlug: 'avatar-essentials',
    });
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    fireEvent.click(await screen.findByRole('button', { name: 'Open details for Avatar Bundle' }));

    const publicPathInput = await screen.findByRole('textbox', {
      name: 'Public product link',
    });
    fireEvent.change(publicPathInput, { target: { value: 'avatar-essentials' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save public product link' }));

    await waitFor(() =>
      expect(apiPutMock).toHaveBeenCalledWith(
        '/api/creator/packages/by-package/com.creator.avatar-bundle/public-link',
        { publicSlug: 'avatar-essentials' }
      )
    );
    expect(
      await screen.findByText(/\/get-in-unity\/mapache\/avatar-essentials/)
    ).toBeInTheDocument();
  });

  it('shows friendly provider and store-tier labels in product details', async () => {
    const providerProductRef = 'F3EmkaR3cc6fbccab49a';
    const providerTierRef = 'gumroad|product|359560112233|variant|17:comercial license';
    const productWithOpaqueStoreReferences = {
      ...product,
      productId: '359560112233',
      providerProductRef,
      catalogTiers: [
        {
          ...product.catalogTiers[0],
          displayName: 'Commercial buyers',
          providerTierRef,
        },
        {
          ...product.catalogTiers[0],
          _id: 'catalog_tier_everyday',
          displayName: 'Everyday buyers',
          providerTierRef: 'gumroad|product|359560112233|variant|16:everyday edition',
        },
        {
          ...product.catalogTiers[0],
          _id: 'catalog_tier_legacy',
          displayName: 'Legacy buyers',
          providerTierRef: '24: Legacy',
        },
      ],
    };
    apiGetMock.mockImplementation((path: string) => {
      if (path === '/api/creator/packages') {
        return Promise.resolve({
          data: [productWithOpaqueStoreReferences],
          hasMore: false,
          nextCursor: null,
        });
      }
      if (path === '/api/creator/packages/catalog_product_1') {
        return Promise.resolve(productWithOpaqueStoreReferences);
      }
      if (path === '/api/creator/packages/by-package/com.creator.avatar-bundle/vcc-link') {
        return Promise.resolve({
          status: 'inactive',
          bootstrapDownloadUrl:
            '/api/creator/packages/by-package/com.creator.avatar-bundle/bootstrap',
        });
      }
      return Promise.reject(new Error(`Unexpected GET ${path}`));
    });
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    fireEvent.click(await screen.findByRole('button', { name: 'Open details for Avatar Bundle' }));

    expect(await screen.findByText('Package editions')).toBeInTheDocument();
    expect(screen.queryByText('Synced access tiers')).not.toBeInTheDocument();
    expect(screen.getByText('Commercial buyers', { selector: 'p' })).toBeVisible();
    expect(screen.getByText('Everyday buyers', { selector: 'p' })).toBeVisible();
    expect(screen.getByText('Legacy buyers', { selector: 'p' })).toBeVisible();
    expect(screen.queryByText(new RegExp(providerProductRef, 'i'))).not.toBeInTheDocument();
    expect(screen.queryByText(/gumroad\|product\|/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/17:comercial license/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/16:everyday edition/i)).not.toBeInTheDocument();
  });

  it('labels the upload product picker and its dialog without accessibility warnings', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    try {
      render(<Component />, { wrapper: createWrapper() });

      expect(await screen.findByText('Avatar Bundle')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Upload a package' }));
      await waitFor(() =>
        expect(apiGetMock).toHaveBeenCalledWith('/api/creator/packages', {
          params: { configured: 'false', limit: '100' },
        })
      );
      await screen.findByText('Choose a product');
      const pickerTrigger = document.querySelector(
        '[data-slot="autocomplete-trigger"] button[aria-haspopup="listbox"]'
      );
      expect(pickerTrigger).toBeInstanceOf(HTMLButtonElement);
      fireEvent.click(pickerTrigger as HTMLButtonElement);
      expect(
        await screen.findByRole('option', {
          name: /First Upload Product/i,
        })
      ).toBeInTheDocument();

      expect(pickerTrigger).toHaveAccessibleName(/Product/i);
      expect(screen.getByText('Product', { selector: '[data-slot="label"]' })).toHaveClass(
        'sr-only'
      );
      expect(screen.getByText('Search products', { selector: '[data-slot="label"]' })).toHaveClass(
        'sr-only'
      );
      expect(screen.getByRole('listbox', { name: /Products available for upload/i })).toBeVisible();
      expect(screen.getByRole('heading', { name: 'Choose a product' })).toHaveClass('sr-only');
      expect(document.querySelector('[data-slot="autocomplete-popover-dialog"]')).toHaveAttribute(
        'aria-label',
        'Choose a product'
      );
      expect(
        document.querySelector('[data-slot="autocomplete-popover-dialog"]')
      ).toHaveAccessibleName('Choose a product');
      const consoleOutput = [...warnSpy.mock.calls, ...errorSpy.mock.calls]
        .flat()
        .map(String)
        .join(' ');
      expect(consoleOutput).not.toMatch(/If you do not provide a visible label/i);
      expect(consoleOutput).not.toMatch(/If a Dialog does not contain a <Heading slot="title">/i);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('identifies products from creator workspaces the publisher collaborates with', async () => {
    apiGetMock.mockImplementation(
      (path: string, options?: { params?: { configured?: string } }) => {
        if (path === '/api/creator/packages') {
          return Promise.resolve({
            data: options?.params?.configured === 'false' ? [collaboratorProduct] : [product],
            hasMore: false,
            nextCursor: null,
          });
        }
        return Promise.reject(new Error(`Unexpected GET ${path}`));
      }
    );
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    fireEvent.click(await screen.findByRole('button', { name: 'Upload a package' }));
    fireEvent.click(await screen.findByLabelText('Product'));

    const option = await screen.findByRole('option', { name: /Collaborator Product/i });
    expect(option).toHaveTextContent('Shared Creator Store');
    expect(option).toHaveTextContent('Jinxxy');
  });

  it('keeps the main list configured-only while the picker exposes first uploads once', async () => {
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });

    expect(await screen.findByText('Avatar Bundle')).toBeInTheDocument();
    expect(screen.queryByText('First Upload Product')).not.toBeInTheDocument();
    expect(screen.queryByText('Cross-store Product')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Upload a package' }));
    expect(screen.queryByText('Server protection')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Protect supported visual assets' })).toBeNull();
    expect(
      screen.queryAllByText(/catalog product|package registry|creator identity/i)
    ).toHaveLength(0);
    await waitFor(() =>
      expect(apiGetMock).toHaveBeenCalledWith('/api/creator/packages', {
        params: { configured: 'false', limit: '100' },
      })
    );
    fireEvent.click(await screen.findByLabelText('Product'));

    const firstUploadOption = await screen.findByRole('option', {
      name: /First Upload Product/i,
    });
    expect(firstUploadOption).toBeInTheDocument();
    expect(screen.getAllByRole('option', { name: /Cross-store Product/i })).toHaveLength(1);
    expect(screen.getByRole('option', { name: /Cross-store Product/i })).toHaveTextContent(
      /Gumroad.*Jinxxy/i
    );

    fireEvent.click(firstUploadOption);
    fireEvent.change(screen.getByLabelText('Install ID'), {
      target: { value: 'com.creator.first-upload' },
    });
    fireEvent.change(screen.getByLabelText('Release label'), { target: { value: '1.0.0' } });
    const file = new File(['package bytes'], 'first-upload.zip', {
      type: 'application/zip',
    });
    fireEvent.change(screen.getByLabelText('Choose package file'), {
      target: {
        files: Object.assign([file], {
          item: (index: number) => (index === 0 ? file : null),
        }),
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Upload package' }));

    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith('/api/creator/uploads/authorize', {
        packageId: 'com.creator.first-upload',
        version: '1.0.0',
        catalogProductIds: ['catalog_product_first_upload'],
        editionId: 'standard',
      })
    );
  });

  it('projects every unmatched provider tier as a package edition', async () => {
    const productWithProviderTiers = {
      ...product,
      catalogProductIds: ['catalog_product_1', 'catalog_product_patreon', 'catalog_product_jinxxy'],
      catalogTiers: [
        ...product.catalogTiers,
        {
          _id: 'catalogtierpatreongold',
          catalogProductId: 'catalog_product_patreon',
          createdAt: 3,
          displayName: 'Gold patrons',
          provider: 'patreon',
          providerTierRef: 'gold',
          status: 'active' as const,
          updatedAt: 4,
        },
        {
          _id: 'catalogtierpatreonplatinum',
          catalogProductId: 'catalog_product_patreon',
          createdAt: 4,
          displayName: 'Platinum patrons',
          provider: 'patreon',
          providerTierRef: 'platinum',
          status: 'active' as const,
          updatedAt: 5,
        },
        {
          _id: 'catalogtierjinxxypersonal',
          catalogProductId: 'catalog_product_jinxxy',
          createdAt: 6,
          displayName: 'Personal license',
          provider: 'jinxxy',
          providerTierRef: 'personal',
          status: 'active' as const,
          updatedAt: 7,
        },
      ],
      storefronts: [
        {
          catalogProductId: 'catalog_product_1',
          productId: product.productId,
          provider: 'gumroad',
          providerProductRef: product.providerProductRef,
        },
        {
          catalogProductId: 'catalog_product_patreon',
          productId: 'patreon-avatar-bundle',
          provider: 'patreon',
          providerProductRef: 'patreon-avatar-bundle',
        },
        {
          catalogProductId: 'catalog_product_jinxxy',
          productId: 'jinxxy-avatar-bundle',
          provider: 'jinxxy',
          providerProductRef: 'jinxxy-avatar-bundle',
        },
      ],
    };
    apiGetMock.mockImplementation(
      (path: string, options?: { params?: { configured?: string } }) => {
        if (path === '/api/creator/packages') {
          return Promise.resolve({
            data: [productWithProviderTiers],
            hasMore: false,
            nextCursor: null,
          });
        }
        if (
          path.match(
            /^\/api\/creator\/packages\/by-package\/[^/]+\/editions\/[^/]+\/versions\/[^/]+\/status$/
          )
        ) {
          return Promise.resolve({
            editionId: 'tier-catalogtierpatreongold',
            errorCategory: null,
            errorCode: null,
            estimatedStartAt: null,
            packageId: 'com.creator.avatar-bundle',
            queuePosition: null,
            state: 'ready',
            updatedAt: '2026-07-26T12:00:00.000Z',
            version: '2.0.0',
            versionId: 'version-2',
          });
        }
        return Promise.reject(
          new Error(`Unexpected GET ${path} ${options?.params?.configured ?? ''}`)
        );
      }
    );
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    const productName = await screen.findByText('Avatar Bundle');
    const productRow = productName.closest('.pm-product-row');
    if (!productRow) throw new Error('Product row was not rendered');

    fireEvent.click(within(productRow).getByRole('button', { name: 'Upload' }));

    fireEvent.click(screen.getByLabelText('Package edition'));
    expect(await screen.findByRole('option', { name: /Commercial/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Gold patrons/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Platinum patrons/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Personal license/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /Gold patrons/i }));
    fireEvent.change(screen.getByLabelText('Release label'), {
      target: { value: '2.0.0' },
    });
    const file = new File(['package bytes'], 'avatar-patreon-gold.zip', {
      type: 'application/zip',
    });
    fireEvent.change(screen.getByLabelText('Choose package file'), {
      target: {
        files: Object.assign([file], {
          item: (index: number) => (index === 0 ? file : null),
        }),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload package' }));

    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith('/api/creator/uploads/authorize', {
        packageId: 'com.creator.avatar-bundle',
        version: '2.0.0',
        catalogProductIds: [
          'catalog_product_1',
          'catalog_product_patreon',
          'catalog_product_jinxxy',
        ],
        catalogTierId: 'catalogtierpatreongold',
        editionId: 'tier-catalogtierpatreongold',
      })
    );
  });

  it('keeps routine package publishing copy concise', async () => {
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });

    expect(await screen.findByText('Avatar Bundle')).toBeInTheDocument();
    expect(screen.queryByText('Customer setup steps')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Upload a package' }));
    expect(screen.queryByText('Ownership check')).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        'We confirm that you own this product and can publish updates for its install ID.'
      )
    ).not.toBeInTheDocument();
  });

  it('keeps an active upload and its inputs when the drawer closes', async () => {
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    const productName = await screen.findByText('Avatar Bundle');
    const productRow = productName.closest('.pm-product-row');
    if (!productRow) throw new Error('Product row was not rendered');

    fireEvent.click(within(productRow).getByRole('button', { name: 'Upload' }));
    fireEvent.change(screen.getByLabelText('Release label'), { target: { value: '2.4.0' } });
    const file = new File(['package bytes'], 'avatar-bundle.spp', {
      type: 'application/octet-stream',
    });
    fireEvent.change(screen.getByLabelText('Choose package file'), {
      target: {
        files: Object.assign([file], {
          item: (index: number) => (index === 0 ? file : null),
        }),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload package' }));
    expect(await screen.findByRole('button', { name: 'Uploading package...' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(await screen.findByText('Uploading avatar-bundle.spp: 50%')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'View upload' }));
    expect(screen.getByLabelText('Install ID')).toHaveValue('com.creator.avatar-bundle');
    expect(screen.getByLabelText('Release label')).toHaveValue('2.4.0');
    expect(screen.getByText('avatar-bundle.spp')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Uploading package...' })).toBeDisabled();
  });

  it('keeps a partial upload draft when the drawer closes before file selection', async () => {
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    const productName = await screen.findByText('Avatar Bundle');
    const productRow = productName.closest('.pm-product-row');
    if (!productRow) throw new Error('Product row was not rendered');

    fireEvent.click(within(productRow).getByRole('button', { name: 'Upload' }));
    fireEvent.change(screen.getByLabelText('Release label'), { target: { value: '2.4.1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Upload a package' }));

    expect(screen.getByLabelText('Install ID')).toHaveValue('com.creator.avatar-bundle');
    expect(screen.getByLabelText('Release label')).toHaveValue('2.4.1');
  });

  it('keeps a partial upload draft when the drawer backdrop closes it', async () => {
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    const productName = await screen.findByText('Avatar Bundle');
    const productRow = productName.closest('.pm-product-row');
    if (!productRow) throw new Error('Product row was not rendered');

    fireEvent.click(within(productRow).getByRole('button', { name: 'Upload' }));
    fireEvent.change(screen.getByLabelText('Release label'), { target: { value: '2.4.2' } });
    fireEvent.pointerDown(document.body);
    fireEvent.pointerUp(document.body);
    fireEvent.click(document.body);

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Upload a package' })).not.toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Upload a package' }));

    expect(screen.getByLabelText('Install ID')).toHaveValue('com.creator.avatar-bundle');
    expect(screen.getByLabelText('Release label')).toHaveValue('2.4.2');
  });

  it('shows preparation after every package byte reaches the server', async () => {
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    const productName = await screen.findByText('Avatar Bundle');
    const productRow = productName.closest('.pm-product-row');
    if (!productRow) throw new Error('Product row was not rendered');

    fireEvent.click(within(productRow).getByRole('button', { name: 'Upload' }));
    fireEvent.change(screen.getByLabelText('Release label'), { target: { value: '2.4.2' } });
    const file = new File(['package bytes'], 'avatar-bundle.zip', {
      type: 'application/zip',
    });
    fireEvent.change(screen.getByLabelText('Choose package file'), {
      target: {
        files: Object.assign([file], {
          item: (index: number) => (index === 0 ? file : null),
        }),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload package' }));
    await waitFor(() => expect(uploadStartMock).toHaveBeenCalledOnce());

    uploadProgressRef.current?.(100, 100);

    expect(await screen.findByText('Checking your package...')).toBeVisible();
    expect(screen.queryByText('Uploading 100%')).not.toBeInTheDocument();
  });

  it('does not expose backend implementation details when an upload transport fails', async () => {
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    const productName = await screen.findByText('Avatar Bundle');
    const productRow = productName.closest('.pm-product-row');
    if (!productRow) throw new Error('Product row was not rendered');

    fireEvent.click(within(productRow).getByRole('button', { name: 'Upload' }));
    fireEvent.change(screen.getByLabelText('Release label'), { target: { value: '2.4.0' } });
    const file = new File(['package bytes'], 'avatar-bundle.zip', {
      type: 'application/zip',
    });
    fireEvent.change(screen.getByLabelText('Choose package file'), {
      target: {
        files: Object.assign([file], {
          item: (index: number) => (index === 0 ? file : null),
        }),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload package' }));
    await waitFor(() => expect(uploadStartMock).toHaveBeenCalledOnce());

    uploadErrorRef.current?.(
      new Error(
        'tus: unexpected response while creating upload: duplicate key value violates unique constraint "package_versions_package_version_unique"'
      )
    );

    expect(
      await screen.findAllByText(
        'The package upload was interrupted. Your draft is safe. Check your connection and try again.'
      )
    ).not.toHaveLength(0);
    expect(screen.queryByText(/unique constraint/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Release label'), { target: { value: '2.4.1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry upload' }));

    expect(await screen.findByRole('button', { name: 'Uploading package...' })).toBeDisabled();
    expect(
      screen.queryByText(
        'The package upload was interrupted. Your draft is safe. Check your connection and try again.'
      )
    ).not.toBeInTheDocument();
  });

  it('discards a lane left behind by an upload that already failed', async () => {
    localStorage.setItem(
      acceptedUploadLaneStorageKey,
      JSON.stringify({
        catalogProductId: 'catalog_product_1',
        editionId: 'standard',
        fileName: 'Song Thing_2.0.0.unitypackage',
        fileSize: 1024,
        packageId: 'com.creator.avatar-bundle',
        progress: 100,
        status: 'failed',
        version: '2.0.0',
        versionId: 'version-already-failed',
      })
    );
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });

    expect(await screen.findByText('Avatar Bundle')).toBeInTheDocument();
    expect(screen.queryByText('Song Thing_2.0.0.unitypackage')).not.toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem(acceptedUploadLaneStorageKey)).toBeNull());
  });

  it('keeps the authorized version recovery handle when tus creation reports a server conflict', async () => {
    apiPostMock.mockResolvedValue({
      versionId: 'version-authorized-before-tus',
      exp: '123',
      sig: 'signature',
      tusEndpoint: 'https://ingest.test/files',
      headers: { 'X-YUCP-Version-Id': 'version-authorized-before-tus' },
      catalogProductId: 'catalog_product_1',
      protectionPolicyId: 'supported-visual-assets-v2',
    });
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    const productName = await screen.findByText('Avatar Bundle');
    const productRow = productName.closest('.pm-product-row');
    if (!productRow) throw new Error('Product row was not rendered');

    fireEvent.click(within(productRow).getByRole('button', { name: 'Upload' }));
    fireEvent.change(screen.getByLabelText('Release label'), { target: { value: '2.4.3' } });
    const file = new File(['package bytes'], 'avatar-bundle.zip', {
      type: 'application/zip',
    });
    fireEvent.change(screen.getByLabelText('Choose package file'), {
      target: {
        files: Object.assign([file], {
          item: (index: number) => (index === 0 ? file : null),
        }),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload package' }));
    await waitFor(() => expect(uploadStartMock).toHaveBeenCalledOnce());

    uploadErrorRef.current?.(
      Object.assign(new Error('tus: unexpected response while creating upload'), {
        originalResponse: {
          getStatus: () => 500,
        },
      })
    );

    expect(await screen.findByRole('button', { name: 'Check package status' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Retry upload' })).toBeEnabled();
    expect(localStorage.getItem(acceptedUploadLaneStorageKey)).toBeNull();
  });

  it('resumes watching when a conflict names a version that is still preparing', async () => {
    let statusPolls = 0;
    apiPostMock.mockResolvedValue({
      versionId: 'version-conflict-preparing',
      exp: '123',
      sig: 'signature',
      tusEndpoint: 'https://ingest.test/files',
      headers: { 'X-YUCP-Version-Id': 'version-conflict-preparing' },
      catalogProductId: 'catalog_product_1',
      protectionPolicyId: 'supported-visual-assets-v2',
    });
    apiGetMock.mockImplementation((path: string) => {
      if (path === '/api/creator/packages') {
        return Promise.resolve({ data: [product], hasMore: false, nextCursor: null });
      }
      if (path === versionStatusPath('version-conflict-preparing')) {
        statusPolls += 1;
        return Promise.resolve({
          editionId: 'standard',
          errorCategory: null,
          errorCode: null,
          estimatedStartAt: null,
          packageId: 'com.creator.avatar-bundle',
          queuePosition: null,
          state: statusPolls === 1 ? 'preparing' : 'ready',
          updatedAt: '2026-07-26T12:00:00.000Z',
          version: '2.6.0',
          versionId: 'version-conflict-preparing',
        });
      }
      if (path === '/api/creator/packages/catalog_product_1') {
        return Promise.resolve(product);
      }
      if (path === '/api/creator/packages/by-package/com.creator.avatar-bundle/vcc-link') {
        return Promise.resolve({
          status: 'inactive',
          bootstrapDownloadUrl:
            '/api/creator/packages/by-package/com.creator.avatar-bundle/bootstrap',
        });
      }
      return Promise.reject(new Error(`Unexpected GET ${path}`));
    });
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    const productName = await screen.findByText('Avatar Bundle');
    const productRow = productName.closest('.pm-product-row');
    if (!productRow) throw new Error('Product row was not rendered');
    fireEvent.click(within(productRow).getByRole('button', { name: 'Upload' }));
    fireEvent.change(screen.getByLabelText('Release label'), { target: { value: '2.6.0' } });
    const file = new File(['package bytes'], 'avatar-bundle-conflict.zip', {
      type: 'application/zip',
    });
    fireEvent.change(screen.getByLabelText('Choose package file'), {
      target: { files: Object.assign([file], { item: () => file }) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload package' }));
    await waitFor(() => expect(uploadStartMock).toHaveBeenCalledOnce());

    uploadErrorRef.current?.(
      Object.assign(new Error('tus: unexpected response while creating upload'), {
        originalResponse: {
          getStatus: () => 409,
        },
      })
    );

    await waitFor(() => expect(statusPolls).toBeGreaterThan(1));
    expect(screen.queryByText(/needs attention/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/already exists/i)).not.toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem(acceptedUploadLaneStorageKey)).toBeNull());
    expect(apiPostMock).toHaveBeenCalledTimes(1);
  });

  it('shows server preparation until the uploaded version becomes ready', async () => {
    let statusPolls = 0;
    const states = ['queued', 'preparing', 'publishing', 'ready'] as const;
    apiPostMock.mockResolvedValue({
      versionId: 'version-processing',
      exp: '123',
      sig: 'signature',
      tusEndpoint: 'https://ingest.test/files',
      headers: { 'X-YUCP-Version-Id': 'version-processing' },
      catalogProductId: 'catalog_product_1',
      protectionPolicyId: 'supported-visual-assets-v2',
    });
    apiGetMock.mockImplementation(
      (path: string, options?: { params?: { configured?: string } }) => {
        if (path === '/api/creator/packages') {
          return Promise.resolve({
            data: [product],
            hasMore: false,
            nextCursor: null,
          });
        }
        if (path === versionStatusPath('version-processing')) {
          expect(options).toBeUndefined();
          statusPolls += 1;
          return Promise.resolve({
            editionId: 'standard',
            errorCategory: null,
            errorCode: null,
            estimatedStartAt: null,
            packageId: 'com.creator.avatar-bundle',
            queuePosition: null,
            state: states[statusPolls - 1] ?? 'ready',
            updatedAt: '2026-07-26T12:00:00.000Z',
            version: '2.5.0',
            versionId: 'version-processing',
          });
        }
        if (path === '/api/creator/packages/catalog_product_1') {
          return Promise.resolve(product);
        }
        if (path === '/api/creator/packages/by-package/com.creator.avatar-bundle/vcc-link') {
          return Promise.resolve({
            status: 'inactive',
            bootstrapDownloadUrl:
              '/api/creator/packages/by-package/com.creator.avatar-bundle/bootstrap',
          });
        }
        return Promise.reject(
          new Error(`Unexpected GET ${path} ${options?.params?.configured ?? ''}`)
        );
      }
    );
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    const productName = await screen.findByText('Avatar Bundle');
    const productRow = productName.closest('.pm-product-row');
    if (!productRow) throw new Error('Product row was not rendered');
    fireEvent.click(within(productRow).getByRole('button', { name: 'Upload' }));
    fireEvent.change(screen.getByLabelText('Release label'), { target: { value: '2.5.0' } });
    const file = new File(['package bytes'], 'avatar-bundle.zip', {
      type: 'application/zip',
    });
    fireEvent.change(screen.getByLabelText('Choose package file'), {
      target: {
        files: Object.assign([file], {
          item: (index: number) => (index === 0 ? file : null),
        }),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload package' }));
    await waitFor(() => expect(uploadStartMock).toHaveBeenCalledOnce());

    uploadSuccessRef.current?.();
    expect(await screen.findByText('Waiting for a preparation slot...')).toBeVisible();
    expect(screen.queryByText('Version ready')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Close'));
    expect(await screen.findByText('Waiting to prepare avatar-bundle.zip')).toBeVisible();
    expect(await screen.findByText('Preparing avatar-bundle.zip')).toBeVisible();
    expect(await screen.findByText('Publishing avatar-bundle.zip')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'View upload' }));

    await waitFor(() => expect(statusPolls).toBe(4), {
      timeout: 3_000,
    });
    await waitFor(() => expect(localStorage.getItem(acceptedUploadLaneStorageKey)).toBeNull());
    expect(statusPolls).toBe(4);
  });

  it('continues preparation after the initial status checks and observes a later ready result', async () => {
    let statusPolls = 0;
    const readyAfterPolls = 12;
    apiPostMock.mockResolvedValue({
      versionId: 'version-delayed-ready',
      exp: '123',
      sig: 'signature',
      tusEndpoint: 'https://ingest.test/files',
      headers: { 'X-YUCP-Version-Id': 'version-delayed-ready' },
      catalogProductId: 'catalog_product_1',
      protectionPolicyId: 'supported-visual-assets-v2',
    });
    apiGetMock.mockImplementation((path: string) => {
      if (path === '/api/creator/packages') {
        return Promise.resolve({ data: [product], hasMore: false, nextCursor: null });
      }
      if (path === versionStatusPath('version-delayed-ready')) {
        statusPolls += 1;
        return Promise.resolve({
          editionId: 'standard',
          errorCategory: null,
          errorCode: null,
          estimatedStartAt: null,
          packageId: 'com.creator.avatar-bundle',
          queuePosition: null,
          state: statusPolls <= readyAfterPolls ? 'preparing' : 'ready',
          updatedAt: '2026-07-26T12:00:00.000Z',
          version: '2.5.2',
          versionId: 'version-delayed-ready',
        });
      }
      if (path === '/api/creator/packages/catalog_product_1') {
        return Promise.resolve(product);
      }
      if (path === '/api/creator/packages/by-package/com.creator.avatar-bundle/vcc-link') {
        return Promise.resolve({
          status: 'inactive',
          bootstrapDownloadUrl:
            '/api/creator/packages/by-package/com.creator.avatar-bundle/bootstrap',
        });
      }
      return Promise.reject(new Error(`Unexpected GET ${path}`));
    });
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    const productName = await screen.findByText('Avatar Bundle');
    const productRow = productName.closest('.pm-product-row');
    if (!productRow) throw new Error('Product row was not rendered');
    fireEvent.click(within(productRow).getByRole('button', { name: 'Upload' }));
    fireEvent.change(screen.getByLabelText('Release label'), { target: { value: '2.5.2' } });
    const file = new File(['package bytes'], 'avatar-bundle.zip', {
      type: 'application/zip',
    });
    fireEvent.change(screen.getByLabelText('Choose package file'), {
      target: { files: Object.assign([file], { item: () => file }) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload package' }));
    await waitFor(() => expect(uploadStartMock).toHaveBeenCalledOnce());

    vi.useFakeTimers();
    try {
      uploadSuccessRef.current?.();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(121_000);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(statusPolls).toBeGreaterThan(readyAfterPolls);
    expect(statusPolls).toBeLessThan(40);
    expect(screen.queryByText(/needs attention/i)).not.toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem(acceptedUploadLaneStorageKey)).toBeNull());
    expect(apiPostMock).toHaveBeenCalledTimes(1);
  });

  it('restores an accepted server-uploading lane after remount without uploading again', async () => {
    let statusPolls = 0;
    apiPostMock.mockResolvedValue({
      versionId: 'version-remount-ready',
      exp: '123',
      sig: 'signature',
      tusEndpoint: 'https://ingest.test/files',
      headers: { 'X-YUCP-Version-Id': 'version-remount-ready' },
      catalogProductId: 'catalog_product_1',
      protectionPolicyId: 'supported-visual-assets-v2',
    });
    apiGetMock.mockImplementation((path: string) => {
      if (path === '/api/creator/packages') {
        return Promise.resolve({ data: [product], hasMore: false, nextCursor: null });
      }
      if (path === versionStatusPath('version-remount-ready')) {
        statusPolls += 1;
        return Promise.resolve({
          editionId: 'standard',
          errorCategory: null,
          errorCode: null,
          estimatedStartAt: null,
          packageId: 'com.creator.avatar-bundle',
          queuePosition: null,
          state: statusPolls === 1 ? 'uploading' : 'ready',
          updatedAt: '2026-07-26T12:00:00.000Z',
          version: '2.5.3',
          versionId: 'version-remount-ready',
        });
      }
      if (path === '/api/creator/packages/catalog_product_1') {
        return Promise.resolve(product);
      }
      if (path === '/api/creator/packages/by-package/com.creator.avatar-bundle/vcc-link') {
        return Promise.resolve({
          status: 'inactive',
          bootstrapDownloadUrl:
            '/api/creator/packages/by-package/com.creator.avatar-bundle/bootstrap',
        });
      }
      return Promise.reject(new Error(`Unexpected GET ${path}`));
    });
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    const firstRender = render(<Component />, { wrapper: createWrapper() });
    const productName = await screen.findByText('Avatar Bundle');
    const productRow = productName.closest('.pm-product-row');
    if (!productRow) throw new Error('Product row was not rendered');
    fireEvent.click(within(productRow).getByRole('button', { name: 'Upload' }));
    fireEvent.change(screen.getByLabelText('Release label'), { target: { value: '2.5.3' } });
    const file = new File(['package bytes'], 'avatar-bundle-remount.zip', {
      type: 'application/zip',
    });
    fireEvent.change(screen.getByLabelText('Choose package file'), {
      target: { files: Object.assign([file], { item: () => file }) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload package' }));
    await waitFor(() => expect(uploadStartMock).toHaveBeenCalledOnce());
    uploadSuccessRef.current?.();
    expect(await screen.findByText('Checking your package...')).toBeVisible();

    firstRender.unmount();
    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(statusPolls).toBeGreaterThan(0));
    await waitFor(() => expect(localStorage.getItem(acceptedUploadLaneStorageKey)).toBeNull());
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(uploadStartMock).toHaveBeenCalledOnce();
  });

  it('keeps accepted preparation retryable after a transient status request error', async () => {
    let statusPolls = 0;
    apiPostMock.mockResolvedValue({
      versionId: 'version-transient-status',
      exp: '123',
      sig: 'signature',
      tusEndpoint: 'https://ingest.test/files',
      headers: { 'X-YUCP-Version-Id': 'version-transient-status' },
      catalogProductId: 'catalog_product_1',
      protectionPolicyId: 'supported-visual-assets-v2',
    });
    apiGetMock.mockImplementation((path: string) => {
      if (path === '/api/creator/packages') {
        return Promise.resolve({ data: [product], hasMore: false, nextCursor: null });
      }
      if (path === versionStatusPath('version-transient-status')) {
        statusPolls += 1;
        if (statusPolls === 1) {
          return Promise.reject(new Error('temporary network failure'));
        }
        return Promise.resolve({
          editionId: 'standard',
          errorCategory: null,
          errorCode: null,
          estimatedStartAt: null,
          packageId: 'com.creator.avatar-bundle',
          queuePosition: null,
          state: 'ready',
          updatedAt: '2026-07-26T12:00:00.000Z',
          version: '2.5.4',
          versionId: 'version-transient-status',
        });
      }
      if (path === '/api/creator/packages/catalog_product_1') {
        return Promise.resolve(product);
      }
      if (path === '/api/creator/packages/by-package/com.creator.avatar-bundle/vcc-link') {
        return Promise.resolve({
          status: 'inactive',
          bootstrapDownloadUrl:
            '/api/creator/packages/by-package/com.creator.avatar-bundle/bootstrap',
        });
      }
      return Promise.reject(new Error(`Unexpected GET ${path}`));
    });
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    const productName = await screen.findByText('Avatar Bundle');
    const productRow = productName.closest('.pm-product-row');
    if (!productRow) throw new Error('Product row was not rendered');
    fireEvent.click(within(productRow).getByRole('button', { name: 'Upload' }));
    fireEvent.change(screen.getByLabelText('Release label'), { target: { value: '2.5.4' } });
    const file = new File(['package bytes'], 'avatar-bundle-transient.zip', {
      type: 'application/zip',
    });
    fireEvent.change(screen.getByLabelText('Choose package file'), {
      target: { files: Object.assign([file], { item: () => file }) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload package' }));
    await waitFor(() => expect(uploadStartMock).toHaveBeenCalledOnce());
    uploadSuccessRef.current?.();

    await waitFor(() => expect(localStorage.getItem(acceptedUploadLaneStorageKey)).toBeNull());
    expect(screen.queryByText(/needs attention/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/temporary network failure/i)).not.toBeInTheDocument();
    expect(apiPostMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a ready accepted upload retryable when the product refresh fails', async () => {
    let productRefreshes = 0;
    apiPostMock.mockResolvedValue({
      versionId: 'version-ready-refresh',
      exp: '123',
      sig: 'signature',
      tusEndpoint: 'https://ingest.test/files',
      headers: { 'X-YUCP-Version-Id': 'version-ready-refresh' },
      catalogProductId: 'catalog_product_1',
      protectionPolicyId: 'supported-visual-assets-v2',
    });
    apiGetMock.mockImplementation((path: string) => {
      if (path === '/api/creator/packages') {
        return Promise.resolve({ data: [product], hasMore: false, nextCursor: null });
      }
      if (path === versionStatusPath('version-ready-refresh')) {
        return Promise.resolve({
          editionId: 'standard',
          errorCategory: null,
          errorCode: null,
          estimatedStartAt: null,
          packageId: 'com.creator.avatar-bundle',
          queuePosition: null,
          state: 'ready',
          updatedAt: '2026-07-26T12:00:00.000Z',
          version: '2.5.5',
          versionId: 'version-ready-refresh',
        });
      }
      if (path === '/api/creator/packages/catalog_product_1') {
        productRefreshes += 1;
        return productRefreshes === 1
          ? Promise.reject(new Error('temporary product refresh failure'))
          : Promise.resolve(product);
      }
      if (path === '/api/creator/packages/by-package/com.creator.avatar-bundle/vcc-link') {
        return Promise.resolve({
          status: 'inactive',
          bootstrapDownloadUrl:
            '/api/creator/packages/by-package/com.creator.avatar-bundle/bootstrap',
        });
      }
      return Promise.reject(new Error(`Unexpected GET ${path}`));
    });
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    const productName = await screen.findByText('Avatar Bundle');
    const productRow = productName.closest('.pm-product-row');
    if (!productRow) throw new Error('Product row was not rendered');
    fireEvent.click(within(productRow).getByRole('button', { name: 'Upload' }));
    fireEvent.change(screen.getByLabelText('Release label'), { target: { value: '2.5.5' } });
    const file = new File(['package bytes'], 'avatar-bundle-ready-refresh.zip', {
      type: 'application/zip',
    });
    fireEvent.change(screen.getByLabelText('Choose package file'), {
      target: { files: Object.assign([file], { item: () => file }) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload package' }));
    await waitFor(() => expect(uploadStartMock).toHaveBeenCalledOnce());
    uploadSuccessRef.current?.();

    await waitFor(() => expect(localStorage.getItem(acceptedUploadLaneStorageKey)).toBeNull());
    expect(screen.queryByText(/needs attention/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/temporary product refresh failure/i)).not.toBeInTheDocument();
    expect(productRefreshes).toBe(2);
    expect(apiPostMock).toHaveBeenCalledTimes(1);
  });

  it('stops polling on a durable failure and gives safe retry guidance', async () => {
    let statusPolls = 0;
    apiPostMock.mockResolvedValue({
      versionId: 'version-failed',
      exp: '123',
      sig: 'signature',
      tusEndpoint: 'https://ingest.test/files',
      headers: { 'X-YUCP-Version-Id': 'version-failed' },
      catalogProductId: 'catalog_product_1',
      protectionPolicyId: 'supported-visual-assets-v2',
    });
    apiGetMock.mockImplementation((path: string, options?: { params?: { packageId?: string } }) => {
      if (path === '/api/creator/packages') {
        return Promise.resolve({ data: [product], hasMore: false, nextCursor: null });
      }
      if (path === versionStatusPath('version-failed')) {
        expect(options).toBeUndefined();
        statusPolls += 1;
        return Promise.resolve({
          editionId: 'standard',
          errorCategory: 'processing',
          errorCode: 'PACKAGE_VERSION_PROCESSING_FAILED',
          estimatedStartAt: null,
          packageId: 'com.creator.avatar-bundle',
          queuePosition: null,
          state: 'failed',
          updatedAt: '2026-07-26T12:00:00.000Z',
          version: '2.5.1',
          versionId: 'version-failed',
        });
      }
      if (path === '/api/creator/packages/by-package/com.creator.avatar-bundle/vcc-link') {
        return Promise.resolve({
          status: 'inactive',
          bootstrapDownloadUrl:
            '/api/creator/packages/by-package/com.creator.avatar-bundle/bootstrap',
        });
      }
      return Promise.reject(new Error(`Unexpected GET ${path}`));
    });
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    const productName = await screen.findByText('Avatar Bundle');
    const productRow = productName.closest('.pm-product-row');
    if (!productRow) throw new Error('Product row was not rendered');
    fireEvent.click(within(productRow).getByRole('button', { name: 'Upload' }));
    fireEvent.change(screen.getByLabelText('Release label'), { target: { value: '2.5.1' } });
    const file = new File(['package bytes'], 'avatar-bundle.zip', {
      type: 'application/zip',
    });
    fireEvent.change(screen.getByLabelText('Choose package file'), {
      target: { files: Object.assign([file], { item: () => file }) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload package' }));
    await waitFor(() => expect(uploadStartMock).toHaveBeenCalledOnce());

    uploadSuccessRef.current?.();

    expect(
      await screen.findAllByText(
        'We could not prepare this version. Review the package file, then upload a new version or retry this draft.'
      )
    ).not.toHaveLength(0);
    expect(statusPolls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(statusPolls).toBe(1);
    expect(screen.queryByText(/duplicate key|constraint|pipeline/i)).not.toBeInTheDocument();
  });

  it('keeps watching a recoverable promotion failure until the version becomes ready', async () => {
    let statusPolls = 0;
    apiPostMock.mockResolvedValue({
      versionId: 'version-recovering',
      exp: '123',
      sig: 'signature',
      tusEndpoint: 'https://ingest.test/files',
      headers: { 'X-YUCP-Version-Id': 'version-recovering' },
      catalogProductId: 'catalog_product_1',
      protectionPolicyId: 'supported-visual-assets-v2',
    });
    apiGetMock.mockImplementation((path: string) => {
      if (path === '/api/creator/packages') {
        return Promise.resolve({ data: [product], hasMore: false, nextCursor: null });
      }
      if (path === versionStatusPath('version-recovering')) {
        statusPolls += 1;
        return Promise.resolve(
          statusPolls === 1
            ? {
                editionId: 'standard',
                errorCategory: null,
                errorCode: null,
                estimatedStartAt: new Date(Date.now() + 30_000).toISOString(),
                packageId: 'com.creator.avatar-bundle',
                queuePosition: null,
                state: 'recovering',
                updatedAt: new Date().toISOString(),
                version: '2.5.2',
                versionId: 'version-recovering',
              }
            : {
                editionId: 'standard',
                errorCategory: null,
                errorCode: null,
                estimatedStartAt: null,
                packageId: 'com.creator.avatar-bundle',
                queuePosition: null,
                state: 'ready',
                updatedAt: new Date().toISOString(),
                version: '2.5.2',
                versionId: 'version-recovering',
              }
        );
      }
      if (path === '/api/creator/packages/catalog_product_1') {
        return Promise.resolve(product);
      }
      if (path === '/api/creator/packages/by-package/com.creator.avatar-bundle/vcc-link') {
        return Promise.resolve({
          status: 'inactive',
          bootstrapDownloadUrl:
            '/api/creator/packages/by-package/com.creator.avatar-bundle/bootstrap',
        });
      }
      return Promise.reject(new Error(`Unexpected GET ${path}`));
    });
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    const productName = await screen.findByText('Avatar Bundle');
    const productRow = productName.closest('.pm-product-row');
    if (!productRow) throw new Error('Product row was not rendered');
    fireEvent.click(within(productRow).getByRole('button', { name: 'Upload' }));
    fireEvent.change(screen.getByLabelText('Release label'), { target: { value: '2.5.2' } });
    const file = new File(['package bytes'], 'avatar-bundle-recovering.zip', {
      type: 'application/zip',
    });
    fireEvent.change(screen.getByLabelText('Choose package file'), {
      target: { files: Object.assign([file], { item: () => file }) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload package' }));
    await waitFor(() => expect(uploadStartMock).toHaveBeenCalledOnce());

    uploadSuccessRef.current?.();

    expect(await screen.findByText(/Recovering preparation/i)).toBeInTheDocument();
    await waitFor(() => expect(statusPolls).toBeGreaterThanOrEqual(2), { timeout: 2_000 });
    expect(screen.queryByText(/needs attention/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be prepared/i)).not.toBeInTheDocument();
  });

  it('loads another bounded catalog page with visible progress', async () => {
    let resolveNextPage: ((value: unknown) => void) | undefined;
    apiGetMock.mockImplementation((path: string, options?: { params?: { cursor?: string } }) => {
      if (path !== '/api/creator/packages') {
        return Promise.reject(new Error(`Unexpected GET ${path}`));
      }
      if (options?.params?.cursor === 'next-page') {
        return new Promise((resolve) => {
          resolveNextPage = resolve;
        });
      }
      return Promise.resolve({ data: [], hasMore: true, nextCursor: 'next-page' });
    });
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });

    fireEvent.click(await screen.findByRole('button', { name: 'Load more packages' }));
    expect(await screen.findByRole('button', { name: 'Loading more...' })).toBeDisabled();
    resolveNextPage?.({ data: [product], hasMore: false, nextCursor: null });

    expect(await screen.findByText('Avatar Bundle')).toBeInTheDocument();
    expect(apiGetMock).toHaveBeenLastCalledWith('/api/creator/packages', {
      params: { configured: 'true', cursor: 'next-page', limit: '50' },
    });
  });

  it('keeps same-name unlinked storefront products separate until explicit association', async () => {
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });

    fireEvent.click(await screen.findByRole('button', { name: 'Upload a package' }));
    fireEvent.click(await screen.findByLabelText('Product'));

    const search = await screen.findByLabelText('Search products');
    fireEvent.change(search, { target: { value: 'Shared Product' } });
    const sameNameOptions = screen.getAllByRole('option', { name: /Shared Product Name/i });
    expect(sameNameOptions).toHaveLength(2);
    const gumroadOption = sameNameOptions.find((option) => option.textContent?.includes('Gumroad'));
    expect(gumroadOption).toBeDefined();
    fireEvent.click(gumroadOption as HTMLElement);
    fireEvent.change(screen.getByLabelText('Install ID'), {
      target: { value: 'com.creator.shared-product-name' },
    });
    fireEvent.change(screen.getByLabelText('Release label'), { target: { value: '1.0.0' } });
    const file = new File(['package bytes'], 'shared-product.zip', {
      type: 'application/zip',
    });
    fireEvent.change(screen.getByLabelText('Choose package file'), {
      target: {
        files: Object.assign([file], {
          item: (index: number) => (index === 0 ? file : null),
        }),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload package' }));

    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith('/api/creator/uploads/authorize', {
        packageId: 'com.creator.shared-product-name',
        version: '1.0.0',
        catalogProductIds: ['catalog_product_same_name_a'],
        editionId: 'standard',
      })
    );
  });

  it('groups storefront products that share one explicit package association', async () => {
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });

    fireEvent.click(await screen.findByRole('button', { name: 'Upload a package' }));
    fireEvent.click(await screen.findByLabelText('Product'));
    const search = await screen.findByLabelText('Search products');
    fireEvent.change(search, { target: { value: 'Cross-store Product' } });

    expect(screen.getAllByRole('option', { name: /Cross-store Product/i })).toHaveLength(1);
    expect(screen.getByRole('option', { name: /Cross-store Product/i })).toHaveTextContent(
      /Gumroad.*Jinxxy/i
    );
  });

  it('explains how to sync the first product when no upload targets exist', async () => {
    apiGetMock.mockResolvedValueOnce({ data: [], hasMore: false, nextCursor: null });
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });

    expect(await screen.findByText('No products available for upload')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Connect a supported store and sync its catalog, then return here to upload the first or next package version.'
      )
    ).toBeInTheDocument();
  });

  it('marks the dashboard session expired when the creator packages route returns 401', async () => {
    apiGetMock.mockRejectedValueOnce(new Error('Authentication required'));
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(markSessionExpiredMock).toHaveBeenCalledOnce());
  });

  it('loads product details from the creator session route', async () => {
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });

    fireEvent.click(await screen.findByRole('button', { name: 'Open details for Avatar Bundle' }));

    expect(await screen.findByText('Package editions')).toBeInTheDocument();
    expect(screen.queryByText('Synced access tiers')).not.toBeInTheDocument();
    expect(screen.getByText('Release history')).toBeInTheDocument();
    expect(await screen.findByText('Summer launch / Wave A')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Delete release Summer launch / Wave A' })
    ).toBeInTheDocument();
    expect(apiGetMock).toHaveBeenCalledWith('/api/creator/packages/catalog_product_1');
    expect(apiGetMock).toHaveBeenCalledWith(standardVersionPath, {
      params: { limit: '50' },
    });
  });

  it('loads exact release labels for active and archived editions from scoped history pages', async () => {
    const archivedProduct = {
      ...product,
      packageEditions: [
        ...(product.packageEditions ?? []),
        {
          catalogProductIds: ['catalog_product_1'],
          catalogTierIds: [],
          createdAt: 3,
          displayName: 'Legacy supporters',
          editionId: 'legacy-supporters',
          priority: 50,
          status: 'archived' as const,
          updatedAt: 4,
        },
      ],
    };
    apiGetMock.mockImplementation(
      (path: string, options?: { params?: { configured?: string; limit?: string } }) => {
        if (path === '/api/creator/packages') {
          return Promise.resolve({ data: [archivedProduct], hasMore: false, nextCursor: null });
        }
        if (path === '/api/creator/packages/catalog_product_1') {
          return Promise.resolve(archivedProduct);
        }
        if (path === standardVersionPath) {
          return Promise.resolve({
            data: [exactLabelVersion],
            hasMore: false,
            nextCursor: null,
          });
        }
        if (
          path ===
          '/api/creator/packages/by-package/com.creator.avatar-bundle/editions/legacy-supporters/versions'
        ) {
          return Promise.resolve({
            data: [
              {
                ...exactLabelVersion,
                editionId: 'legacy-supporters',
                version: 'Founders build #7',
                versionId: 'version-founders-seven',
              },
            ],
            hasMore: false,
            nextCursor: null,
          });
        }
        if (path === '/api/creator/packages/by-package/com.creator.avatar-bundle/vcc-link') {
          return Promise.resolve({
            status: 'inactive',
            bootstrapDownloadUrl:
              '/api/creator/packages/by-package/com.creator.avatar-bundle/bootstrap',
          });
        }
        return Promise.reject(
          new Error(`Unexpected GET ${path} ${options?.params?.configured ?? ''}`)
        );
      }
    );
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    fireEvent.click(await screen.findByRole('button', { name: 'Open details for Avatar Bundle' }));

    expect(await screen.findByText('Summer launch / Wave A')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByText(/Current in/i)).not.toBeInTheDocument();
    expect(screen.queryByText('release-root-2')).not.toBeInTheDocument();
    expect(apiGetMock).toHaveBeenCalledWith(standardVersionPath, {
      params: { limit: '50' },
    });

    await selectReleaseHistoryEdition('Legacy supporters');

    expect(await screen.findByText('Founders build #7')).toBeInTheDocument();
    expect(screen.getByLabelText('Release history edition')).toHaveTextContent('Legacy supporters');
  });

  it('shows an empty Standard history before its first Standard release', async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === '/api/creator/packages') {
        return Promise.resolve({ data: [product], hasMore: false, nextCursor: null });
      }
      if (path === '/api/creator/packages/catalog_product_1') {
        return Promise.resolve(product);
      }
      if (path === standardVersionPath) {
        return Promise.resolve({ data: [], hasMore: false, nextCursor: null });
      }
      if (
        path ===
        '/api/creator/packages/by-package/com.creator.avatar-bundle/editions/commercial/versions'
      ) {
        return Promise.resolve({
          data: [
            {
              ...exactLabelVersion,
              editionId: 'commercial',
              version: 'Commercial launch',
              versionId: 'version-commercial-launch',
            },
          ],
          hasMore: false,
          nextCursor: null,
        });
      }
      if (path === '/api/creator/packages/by-package/com.creator.avatar-bundle/vcc-link') {
        return Promise.resolve({
          status: 'inactive',
          bootstrapDownloadUrl:
            '/api/creator/packages/by-package/com.creator.avatar-bundle/bootstrap',
        });
      }
      return Promise.reject(new Error(`Unexpected GET ${path}`));
    });
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    fireEvent.click(await screen.findByRole('button', { name: 'Open details for Avatar Bundle' }));

    expect(
      await screen.findByText('No releases are available for this edition.')
    ).toBeInTheDocument();
    expect(screen.queryByText('Could not load release history.')).not.toBeInTheDocument();

    await selectReleaseHistoryEdition('Commercial');
    expect(await screen.findByText('Commercial launch')).toBeInTheDocument();
  });

  it('shows an error when a configured edition history request fails', async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === '/api/creator/packages') {
        return Promise.resolve({ data: [product], hasMore: false, nextCursor: null });
      }
      if (path === '/api/creator/packages/catalog_product_1') {
        return Promise.resolve(product);
      }
      if (path === standardVersionPath) {
        return Promise.resolve({
          data: [exactLabelVersion],
          hasMore: false,
          nextCursor: null,
        });
      }
      if (
        path ===
        '/api/creator/packages/by-package/com.creator.avatar-bundle/editions/commercial/versions'
      ) {
        return Promise.reject(new Error('Release history request failed'));
      }
      if (path === '/api/creator/packages/by-package/com.creator.avatar-bundle/vcc-link') {
        return Promise.resolve({
          status: 'inactive',
          bootstrapDownloadUrl:
            '/api/creator/packages/by-package/com.creator.avatar-bundle/bootstrap',
        });
      }
      return Promise.reject(new Error(`Unexpected GET ${path}`));
    });
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    fireEvent.click(await screen.findByRole('button', { name: 'Open details for Avatar Bundle' }));
    expect(await screen.findByText('Summer launch / Wave A')).toBeInTheDocument();

    await selectReleaseHistoryEdition('Commercial');

    expect(await screen.findByText('Could not load release history.')).toBeInTheDocument();
  });

  it('loads the next 50-release page with visible pending feedback', async () => {
    let resolveNextPage:
      | ((value: {
          data: Array<typeof exactLabelVersion>;
          hasMore: boolean;
          nextCursor: null;
        }) => void)
      | undefined;
    apiGetMock.mockImplementation(
      (path: string, options?: { params?: { cursor?: string; configured?: string } }) => {
        if (path === '/api/creator/packages') {
          return Promise.resolve({ data: [product], hasMore: false, nextCursor: null });
        }
        if (path === '/api/creator/packages/catalog_product_1') {
          return Promise.resolve(product);
        }
        if (path === standardVersionPath && !options?.params?.cursor) {
          return Promise.resolve({
            data: [exactLabelVersion],
            hasMore: true,
            nextCursor: 'cursor-50',
          });
        }
        if (path === standardVersionPath && options.params?.cursor === 'cursor-50') {
          return new Promise((resolve) => {
            resolveNextPage = resolve;
          });
        }
        if (path === '/api/creator/packages/by-package/com.creator.avatar-bundle/vcc-link') {
          return Promise.resolve({
            status: 'inactive',
            bootstrapDownloadUrl:
              '/api/creator/packages/by-package/com.creator.avatar-bundle/bootstrap',
          });
        }
        return Promise.reject(new Error(`Unexpected GET ${path}`));
      }
    );
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    fireEvent.click(await screen.findByRole('button', { name: 'Open details for Avatar Bundle' }));
    expect(await screen.findByText('Summer launch / Wave A')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Load more releases' }));
    expect(await screen.findByRole('button', { name: 'Loading more releases...' })).toBeDisabled();
    expect(apiGetMock).toHaveBeenCalledWith(standardVersionPath, {
      params: { cursor: 'cursor-50', limit: '50' },
    });

    resolveNextPage?.({
      data: [
        {
          ...exactLabelVersion,
          createdAt: '2026-06-01T10:00:00.000Z',
          updatedAt: '2026-06-01T10:05:00.000Z',
          version: 'Patreon June drop',
          versionId: 'version-june-drop',
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
    expect(await screen.findByText('Patreon June drop')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more releases' })).not.toBeInTheDocument();
  });

  it('removes a deleted release from its scoped page and refetches that page', async () => {
    let versionPageReads = 0;
    let resolveDelete:
      | ((value: { deletedAt: string; state: 'DELETED'; versionId: string }) => void)
      | undefined;
    apiGetMock.mockImplementation((path: string) => {
      if (path === '/api/creator/packages') {
        return Promise.resolve({ data: [product], hasMore: false, nextCursor: null });
      }
      if (path === '/api/creator/packages/catalog_product_1') {
        return Promise.resolve(product);
      }
      if (path === standardVersionPath) {
        versionPageReads += 1;
        return Promise.resolve({
          data:
            versionPageReads === 1
              ? [
                  exactLabelVersion,
                  {
                    ...exactLabelVersion,
                    createdAt: '2026-06-01T10:00:00.000Z',
                    updatedAt: '2026-06-01T10:05:00.000Z',
                    version: 'Patreon June drop',
                    versionId: 'version-june-drop',
                  },
                ]
              : [
                  {
                    ...exactLabelVersion,
                    createdAt: '2026-06-01T10:00:00.000Z',
                    updatedAt: '2026-06-01T10:05:00.000Z',
                    version: 'Patreon June drop',
                    versionId: 'version-june-drop',
                  },
                ],
          hasMore: false,
          nextCursor: null,
        });
      }
      if (path === '/api/creator/packages/by-package/com.creator.avatar-bundle/vcc-link') {
        return Promise.resolve({
          status: 'inactive',
          bootstrapDownloadUrl:
            '/api/creator/packages/by-package/com.creator.avatar-bundle/bootstrap',
        });
      }
      return Promise.reject(new Error(`Unexpected GET ${path}`));
    });
    apiDeleteMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDelete = resolve;
        })
    );
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    fireEvent.click(await screen.findByRole('button', { name: 'Open details for Avatar Bundle' }));
    expect(await screen.findByText('Summer launch / Wave A')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete release Summer launch / Wave A' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete release' }));

    expect(await screen.findByRole('button', { name: 'Deleting release...' })).toBeDisabled();
    expect(apiDeleteMock).toHaveBeenCalledWith(`${standardVersionPath}/version-summer-launch`);
    resolveDelete?.({
      deletedAt: '2026-07-26T13:00:00.000Z',
      state: 'DELETED',
      versionId: 'version-summer-launch',
    });

    await waitFor(() =>
      expect(screen.queryByText('Summer launch / Wave A')).not.toBeInTheDocument()
    );
    await waitFor(() => expect(versionPageReads).toBeGreaterThan(1));
    expect(screen.getByText('Patreon June drop')).toBeInTheDocument();
  });

  it('asks for a friendly release label without suggesting semantic versions', async () => {
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    fireEvent.click(await screen.findByRole('button', { name: 'Upload a package' }));

    expect(await screen.findByLabelText('Release label')).toHaveAttribute(
      'placeholder',
      'Summer launch'
    );
    expect(screen.queryByLabelText('Version')).not.toBeInTheDocument();
  });

  it('searches and links another storefront from package details with visible progress', async () => {
    let resolveLink: ((value: unknown) => void) | undefined;
    apiPutMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLink = resolve;
        })
    );
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    fireEvent.click(await screen.findByRole('button', { name: 'Open details for Avatar Bundle' }));

    const search = await screen.findByLabelText('Search storefronts to link');
    fireEvent.change(search, { target: { value: 'Jinxxy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link Jinxxy storefront' }));

    expect(await screen.findByRole('button', { name: 'Linking Jinxxy...' })).toBeDisabled();
    expect(apiPutMock).toHaveBeenCalledWith(
      '/api/creator/packages/catalog_product_1/storefronts/catalog_product_same_name_b',
      {}
    );
    resolveLink?.({
      bound: true,
      catalogProductId: 'catalog_product_same_name_b',
      packageId: 'com.creator.avatar-bundle',
    });
  });

  it('requires confirmation before unlinking a storefront from package details', async () => {
    const linkedProduct = {
      ...product,
      catalogProductIds: ['catalog_product_1', 'catalog_product_cross_store_jinxxy'],
      storefronts: [
        {
          catalogProductId: 'catalog_product_1',
          productId: product.productId,
          provider: 'gumroad',
          providerProductRef: product.providerProductRef,
        },
        {
          catalogProductId: 'catalog_product_cross_store_jinxxy',
          productId: duplicateJinxxyProduct.productId,
          provider: 'jinxxy',
          providerProductRef: duplicateJinxxyProduct.providerProductRef,
        },
      ],
    };
    apiGetMock.mockImplementation(
      (path: string, options?: { params?: { configured?: string } }) => {
        if (path === '/api/creator/packages') {
          return Promise.resolve({
            data: options?.params?.configured === 'false' ? [linkedProduct] : [linkedProduct],
            hasMore: false,
            nextCursor: null,
          });
        }
        if (path === '/api/creator/packages/catalog_product_1') {
          return Promise.resolve(linkedProduct);
        }
        if (path === standardVersionPath) {
          return Promise.resolve({
            data: [exactLabelVersion],
            hasMore: false,
            nextCursor: null,
          });
        }
        if (path === '/api/creator/packages/by-package/com.creator.avatar-bundle/vcc-link') {
          return Promise.resolve({
            status: 'inactive',
            bootstrapDownloadUrl:
              '/api/creator/packages/by-package/com.creator.avatar-bundle/bootstrap',
          });
        }
        return Promise.reject(new Error(`Unexpected GET ${path}`));
      }
    );
    apiDeleteMock.mockResolvedValue({ unbound: true });
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    fireEvent.click(await screen.findByRole('button', { name: 'Open details for Avatar Bundle' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Unlink Jinxxy storefront' }));

    expect(screen.getByText('Unlink Jinxxy?')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm unlink Jinxxy' }));

    await waitFor(() =>
      expect(apiDeleteMock).toHaveBeenCalledWith(
        '/api/creator/packages/catalog_product_1/storefronts/catalog_product_cross_store_jinxxy'
      )
    );
  });

  it('creates and archives package editions with mapped access tiers', async () => {
    let resolveSave: ((value: { editionId: string; saved: true }) => void) | undefined;
    apiPutMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        })
    );
    apiDeleteMock.mockResolvedValue({ archived: true, editionId: 'commercial' });
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    fireEvent.click(await screen.findByRole('button', { name: 'Open details for Avatar Bundle' }));

    expect(await screen.findByText('Package editions')).toBeInTheDocument();
    expect(screen.getAllByText('Commercial buyers').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Edit edition Commercial' }));
    expect(screen.getByLabelText('Edition name')).toHaveValue('Commercial');
    expect(screen.getByLabelText('Edition ID')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add edition' }));
    fireEvent.change(screen.getByLabelText('Edition name'), {
      target: { value: 'Supporter' },
    });
    fireEvent.change(screen.getByLabelText('Edition ID'), {
      target: { value: 'supporter' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Commercial buyers' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create edition' }));

    expect(await screen.findByRole('button', { name: 'Creating edition...' })).toBeDisabled();
    expect(apiPutMock).toHaveBeenCalledWith(
      '/api/creator/packages/catalog_product_1/editions/supporter',
      {
        catalogProductIds: ['catalog_product_1'],
        catalogTierIds: ['catalog_tier_commercial'],
        displayName: 'Supporter',
        priority: 0,
      }
    );
    resolveSave?.({ editionId: 'supporter', saved: true });
    await waitFor(() =>
      expect(apiGetMock).toHaveBeenCalledWith('/api/creator/packages/catalog_product_1')
    );

    fireEvent.click(screen.getByRole('button', { name: 'Archive edition Commercial' }));
    expect(screen.getByText('Archive Commercial?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Archive edition' }));
    await waitFor(() =>
      expect(apiDeleteMock).toHaveBeenCalledWith(
        '/api/creator/packages/catalog_product_1/editions/commercial'
      )
    );
  });

  it('uploads a release to the selected package edition', async () => {
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    const productName = await screen.findByText('Avatar Bundle');
    const productRow = productName.closest('.pm-product-row');
    if (!productRow) throw new Error('Product row was not rendered');

    fireEvent.click(within(productRow).getByRole('button', { name: 'Upload' }));
    await selectPackageEdition('Commercial');
    fireEvent.change(screen.getByLabelText('Release label'), { target: { value: '3.0.0' } });
    const file = new File(['package bytes'], 'avatar-commercial.zip', {
      type: 'application/zip',
    });
    fireEvent.change(screen.getByLabelText('Choose package file'), {
      target: {
        files: Object.assign([file], {
          item: (index: number) => (index === 0 ? file : null),
        }),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload package' }));

    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith('/api/creator/uploads/authorize', {
        packageId: 'com.creator.avatar-bundle',
        version: '3.0.0',
        catalogProductIds: ['catalog_product_1'],
        editionId: 'commercial',
      })
    );
  });

  it('enables, downloads, and disables tailored Unity access from product details', async () => {
    const defaultGet = apiGetMock.getMockImplementation();
    apiGetMock.mockImplementation((path: string, options?: unknown) => {
      if (path === standardVersionPath) {
        return Promise.resolve({
          data: [
            {
              ...exactLabelVersion,
              state: 'superseded',
              version: '2.1.0',
              versionId: 'version-2-1-0',
            },
          ],
          hasMore: false,
          nextCursor: null,
        });
      }
      return defaultGet?.(path, options);
    });
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: writeTextMock },
    });
    let rejectBootstrapDownload: ((error: Error) => void) | undefined;
    apiBlobMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectBootstrapDownload = reject;
        })
    );
    let resolveCreate:
      | ((value: {
          status: 'active';
          createdAt: number;
          bootstrapDownloadUrl: string;
          unityPackageDownloadUrl: string;
        }) => void)
      | undefined;
    apiPostMock.mockImplementation((path: string) => {
      if (path === '/api/creator/packages/by-package/com.creator.avatar-bundle/vcc-link') {
        return new Promise((resolve) => {
          resolveCreate = resolve;
        });
      }
      return Promise.reject(new Error(`Unexpected POST ${path}`));
    });
    const createdLink = {
      status: 'active',
      createdAt: 1_700_000_000_000,
      bootstrapDownloadUrl: '/api/creator/packages/by-package/com.creator.avatar-bundle/bootstrap',
      unityPackageDownloadUrl:
        '/api/creator/packages/by-package/com.creator.avatar-bundle/bootstrap.unitypackage',
    } as const;
    let resolveRevoke: ((value: { revoked: boolean }) => void) | undefined;
    apiDeleteMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRevoke = resolve;
        })
    );
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });

    fireEvent.click(await screen.findByRole('button', { name: 'Open details for Avatar Bundle' }));
    expect(await screen.findByText('Unity access')).toBeInTheDocument();
    expect(
      screen.getByText("Enable this package in each verified buyer's private creator repository.")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy buyer privacy notice' }));
    await waitFor(() =>
      expect(writeTextMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/legal\/verification-and-attestation$/)
      )
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Download bootstrap' }));
    expect(await screen.findByRole('heading', { name: 'Download bootstrap' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Latest' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Specific version' })).not.toBeChecked();
    expect(
      screen.getByText(
        'Resolves the newest authorized stable release when this bootstrap is imported. It does not subscribe the project to updates.'
      )
    ).toBeInTheDocument();
    expect(await screen.findByText('VPM bootstrap')).toBeInTheDocument();
    expect(screen.getByText('Unitypackage bootstrap')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download VPM bootstrap' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Download Unitypackage bootstrap' })).toBeEnabled();
    fireEvent.click(screen.getByRole('radio', { name: 'Specific version' }));
    const releaseList = await screen.findByLabelText('READY package releases');
    expect(within(releaseList).getByText('2.1.0')).toBeInTheDocument();
    fireEvent.click(within(releaseList).getByText('2.1.0'));
    expect(
      screen.getByText('Pins this bootstrap to 2.1.0. It will never substitute a newer release.')
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Selecting a version in VCC installs that exact release. VCC's Latest option selects the highest published stable SemVer."
      )
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Download VPM bootstrap' }));
    const pendingDownload = await screen.findByRole('button', {
      name: 'Download VPM bootstrap',
    });
    expect(pendingDownload).toBeDisabled();
    expect(pendingDownload).toHaveTextContent('Downloading...');
    expect(screen.getByRole('button', { name: 'Download Unitypackage bootstrap' })).toBeDisabled();
    expect(apiBlobMock).toHaveBeenCalledWith(
      '/api/creator/packages/by-package/com.creator.avatar-bundle/bootstrap',
      {
        params: {
          editionId: 'standard',
          mode: 'specific',
          versionId: 'version-2-1-0',
        },
      }
    );
    rejectBootstrapDownload?.(new Error('Bootstrap generation failed'));
    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith('Could not download the bootstrap', {
        description: 'Bootstrap generation failed',
      })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Enable Unity access' }));
    expect(await screen.findByRole('button', { name: 'Creating access...' })).toBeDisabled();
    resolveCreate?.(createdLink);
    expect(await screen.findByText('Enabled')).toBeInTheDocument();
    expect(
      screen.getByText(
        'A verified buyer sees this package automatically in the one private repository they receive for your creator profile.'
      )
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Disable Unity access' }));
    expect(
      screen.getByText(
        'This package disappears from tailored buyer repositories. Packages already installed in Unity stay in their projects.'
      )
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disable access' }));
    expect(await screen.findByRole('button', { name: 'Disabling...' })).toBeDisabled();
    await waitFor(() =>
      expect(apiDeleteMock).toHaveBeenCalledWith(
        '/api/creator/packages/by-package/com.creator.avatar-bundle/vcc-link'
      )
    );
    resolveRevoke?.({ revoked: true });
    expect(await screen.findByRole('button', { name: 'Enable Unity access' })).toBeInTheDocument();
  });

  it('lets the creator publish a friendly bootstrap package name', async () => {
    apiPutMock.mockResolvedValueOnce({
      packageName: 'Avatar Essentials',
      published: true,
    });
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    fireEvent.click(await screen.findByRole('button', { name: 'Open details for Avatar Bundle' }));

    const packageNameInput = await screen.findByLabelText('Bootstrap package name');
    expect(packageNameInput).toHaveValue('Avatar Bundle');
    fireEvent.change(packageNameInput, {
      target: { value: 'Avatar Essentials' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save bootstrap name' }));

    await waitFor(() =>
      expect(apiPutMock).toHaveBeenCalledWith(
        '/api/creator/packages/by-package/com.creator.avatar-bundle/presentation',
        { packageName: 'Avatar Essentials' }
      )
    );
  });

  it('authorizes and starts a real resumable upload from the restored product lane', async () => {
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    const productName = await screen.findByText('Avatar Bundle');
    const productRow = productName.closest('.pm-product-row');
    if (!productRow) throw new Error('Product row was not rendered');

    fireEvent.click(within(productRow).getByRole('button', { name: 'Upload' }));
    expect(await screen.findByLabelText('Install ID')).toHaveValue('com.creator.avatar-bundle');
    fireEvent.change(screen.getByLabelText('Release label'), { target: { value: '2.4.0' } });
    const fileInput = screen.getByLabelText('Choose package file');
    expect(fileInput).toHaveAttribute('accept', expect.stringContaining('.spp'));
    const file = new File(['package bytes'], 'avatar-bundle.spp', {
      type: 'application/octet-stream',
    });
    const files = Object.assign([file], {
      item: (index: number) => (index === 0 ? file : null),
    });
    fireEvent.change(fileInput, {
      target: { files },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Upload package' }));

    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith('/api/creator/uploads/authorize', {
        packageId: 'com.creator.avatar-bundle',
        version: '2.4.0',
        catalogProductIds: ['catalog_product_1'],
        editionId: 'standard',
      })
    );
    expect(uploadStartMock).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Uploading package...' })).toBeDisabled();

    uploadSuccessRef.current?.();
    await waitFor(() => expect(localStorage.getItem(acceptedUploadLaneStorageKey)).toBeNull());
  });
});
