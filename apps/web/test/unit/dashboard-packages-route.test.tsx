import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  apiGetMock,
  apiPostMock,
  markSessionExpiredMock,
  navigateMock,
  routeSearchMock,
  uploadStartMock,
  uploadSuccessRef,
} = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  markSessionExpiredMock: vi.fn(),
  navigateMock: vi.fn(),
  routeSearchMock: vi.fn(() => ({ view: undefined })),
  uploadStartMock: vi.fn(),
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
    get: apiGetMock,
    post: apiPostMock,
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
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
}));

vi.mock('@/lib/hyperdx', () => ({
  startHyperdxBrowserSpan: () => ({ end: vi.fn(), fail: vi.fn() }),
}));

vi.mock('tus-js-client', () => ({
  Upload: class {
    private readonly options: {
      onProgress?: (uploaded: number, total: number) => void;
      onSuccess?: () => void;
    };

    constructor(
      _file: File,
      options: {
        onProgress?: (uploaded: number, total: number) => void;
        onSuccess?: () => void;
      }
    ) {
      this.options = options;
    }

    start = () => {
      uploadStartMock();
      this.options.onProgress?.(50, 100);
      uploadSuccessRef.current = () => this.options.onSuccess?.();
    };
  },
}));

import { Route as DashboardPackagesRoute } from '@/routes/_authenticated/dashboard/packages.lazy';

const product = {
  _id: 'catalog_product_1',
  aliases: ['avatar-bundle'],
  canonicalSlug: 'avatar-bundle',
  catalogTiers: [],
  displayName: 'Avatar Bundle',
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

const firstUploadProduct = {
  ...product,
  _id: 'catalog_product_first_upload',
  aliases: ['First Upload Product'],
  canonicalSlug: 'first-upload-product',
  displayName: 'First Upload Product',
  productId: 'first-upload-product',
  providerProductRef: 'first-upload-ref',
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

describe('dashboard packages route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeSearchMock.mockReturnValue({ view: undefined });
    uploadSuccessRef.current = null;
    apiGetMock.mockImplementation(
      (path: string, options?: { params?: { configured?: string } }) => {
        if (path === '/api/creator/packages') {
          if (options?.params?.configured === 'false') {
            return Promise.resolve({
              data: [
                product,
                firstUploadProduct,
                duplicateGumroadProduct,
                duplicateJinxxyProduct,
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
        return Promise.reject(new Error(`Unexpected GET ${path}`));
      }
    );
    apiPostMock.mockResolvedValue({
      versionId: 'version_1',
      exp: '123',
      sig: 'signature',
      tusEndpoint: 'https://ingest.test/files',
      headers: { 'X-YUCP-Version-Id': 'version_1' },
      catalogProductId: 'catalog_product_1',
    });
  });

  afterEach(() => cleanup());

  it('restores product lanes from the current packageRegistry list contract', async () => {
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });

    expect(screen.getByRole('heading', { name: 'Private VPM Registry' })).toBeInTheDocument();
    expect(await screen.findByText('Avatar Bundle')).toBeInTheDocument();
    expect(screen.getByText(/ready for package uploads/i)).toBeInTheDocument();
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

  it('keeps the main list configured-only while the picker exposes first uploads once', async () => {
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });

    expect(await screen.findByText('Avatar Bundle')).toBeInTheDocument();
    expect(screen.queryByText('First Upload Product')).not.toBeInTheDocument();
    expect(screen.queryByText('Cross-store Product')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Upload a package' }));
    await waitFor(() =>
      expect(apiGetMock).toHaveBeenCalledWith('/api/creator/packages', {
        params: { configured: 'false', limit: '100' },
      })
    );
    fireEvent.click(await screen.findByLabelText('Catalog product'));

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
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '1.0.0' } });
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
        catalogProductId: 'catalog_product_first_upload',
        protectionPolicyId: 'supported-visual-assets-v1',
      })
    );
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

  it('searches and groups matching cross-store products in the upload picker', async () => {
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });

    fireEvent.click(await screen.findByRole('button', { name: 'Upload a package' }));
    fireEvent.click(await screen.findByLabelText('Catalog product'));

    const search = await screen.findByLabelText('Search products');
    fireEvent.change(search, { target: { value: 'Shared Product' } });
    expect(screen.getAllByRole('option', { name: /Shared Product Name/i })).toHaveLength(1);
    expect(screen.getByRole('option', { name: /Shared Product Name/i })).toHaveTextContent(
      /Gumroad.*Jinxxy/i
    );
    fireEvent.click(screen.getByRole('option', { name: /Shared Product Name/i }));
    fireEvent.change(screen.getByLabelText('Install ID'), {
      target: { value: 'com.creator.shared-product-name' },
    });
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '1.0.0' } });
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
        catalogProductId: 'catalog_product_same_name_a',
        protectionPolicyId: 'supported-visual-assets-v1',
      })
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

    expect(await screen.findByText('Synced access tiers')).toBeInTheDocument();
    expect(apiGetMock).toHaveBeenCalledWith('/api/creator/packages/catalog_product_1');
  });

  it('authorizes and starts a real resumable upload from the restored product lane', async () => {
    const Component = DashboardPackagesRoute.options.component;
    if (!Component) throw new Error('Dashboard packages component is missing');

    render(<Component />, { wrapper: createWrapper() });
    const productName = await screen.findByText('Avatar Bundle');
    const productRow = productName.closest('.pm-product-row');
    if (!productRow) throw new Error('Product row was not rendered');

    fireEvent.click(within(productRow).getByRole('button', { name: 'Upload' }));
    fireEvent.change(await screen.findByLabelText('Install ID'), {
      target: { value: 'com.creator.avatar-bundle' },
    });
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '2.4.0' } });
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
        catalogProductId: 'catalog_product_1',
        protectionPolicyId: 'supported-visual-assets-v1',
      })
    );
    expect(uploadStartMock).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Uploading package...' })).toBeDisabled();

    uploadSuccessRef.current?.();
    await waitFor(() => expect(screen.getByText(/upload complete/i)).toBeInTheDocument());
  });
});
