import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  apiPostMock,
  copyToClipboardMock,
  fetchBuyerProductAccessMock,
  loaderDataMock,
  routeSearchMock,
  signInMock,
} = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  copyToClipboardMock: vi.fn(),
  fetchBuyerProductAccessMock: vi.fn(),
  loaderDataMock: vi.fn(),
  routeSearchMock: vi.fn(() => ({ grant: undefined, intent_id: undefined })),
  signInMock: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({
    options,
    useLoaderData: loaderDataMock,
    useSearch: routeSearchMock,
  }),
}));

vi.mock('@/components/three/CloudBackground', () => ({
  CloudBackground: ({ variant }: { variant?: string }) => (
    <div data-testid="cloud-background" data-variant={variant} />
  ),
}));

vi.mock('@/api/client', () => ({
  apiClient: { post: apiPostMock },
}));

vi.mock('@/hooks/usePublicAuth', () => ({
  usePublicAuth: vi.fn(),
}));

vi.mock('@/lib/utils', () => ({
  copyToClipboard: copyToClipboardMock,
}));

vi.mock('@/lib/server/productAccess', () => ({
  fetchBuyerProductAccess: fetchBuyerProductAccessMock,
}));

import { usePublicAuth } from '@/hooks/usePublicAuth';
import { Route as GetInUnityRoute } from '@/routes/get-in-unity.$creatorRef.$productRef';

const productAccess = {
  product: {
    catalogProductId: 'catalog_product_1',
    displayName: 'Avatar Bundle',
    canonicalSlug: 'avatar-bundle',
    thumbnailUrl: null,
    provider: 'gumroad',
    providerLabel: 'Gumroad',
    storefrontUrl: 'https://gumroad.test/avatar-bundle',
    storefronts: [
      {
        catalogProductId: 'catalog/product',
        provider: 'gumroad',
        providerLabel: 'Gumroad',
        storefrontUrl: 'https://gumroad.test/avatar-bundle',
      },
    ],
  },
  accessState: {
    hasActiveEntitlement: false,
    requiresVerification: true,
  },
  repository: null,
};

const stableRepository = {
  indexUrl:
    'https://vpm.test/api/vpm/access/SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS/index.json',
  addRepoUrl:
    'vcc://vpm/addRepo?url=https%3A%2F%2Fvpm.test%2Fapi%2Fvpm%2Faccess%2FSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS%2Findex.json',
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('get in unity route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/get-in-unity/mapache/avatar-bundle');
    loaderDataMock.mockReturnValue(productAccess);
    routeSearchMock.mockReturnValue({ grant: undefined, intent_id: undefined });
    vi.mocked(usePublicAuth).mockReturnValue({
      authUserId: undefined,
      isAuthenticated: false,
      isPending: false,
      signIn: signInMock,
      signOut: vi.fn(),
    });
    copyToClipboardMock.mockResolvedValue(true);
  });

  afterEach(() => cleanup());

  it('passes both public URL segments into creator-scoped product resolution', async () => {
    fetchBuyerProductAccessMock.mockResolvedValue(productAccess);
    const loader = GetInUnityRoute.options.loader;
    if (!loader) throw new Error('Get in Unity loader is missing');

    await loader({
      params: { creatorRef: 'mapache', productRef: 'avatar-bundle' },
    } as never);

    expect(fetchBuyerProductAccessMock).toHaveBeenCalledWith({
      data: { catalogProductId: 'avatar-bundle', creatorRef: 'mapache' },
    });
  });

  it('restores the buyer-facing Unity card and sign-in action', async () => {
    const Component = GetInUnityRoute.options.component;
    if (!Component) throw new Error('Get in Unity component is missing');

    render(<Component />, { wrapper: createWrapper() });

    expect(screen.getByRole('heading', { name: 'Avatar Bundle' })).toBeInTheDocument();
    expect(screen.getByText('Verified for this account')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to continue' }));
    await waitFor(() => expect(signInMock).toHaveBeenCalledOnce());
  });

  it('starts the current product-access verification contract for a signed-in buyer', async () => {
    vi.mocked(usePublicAuth).mockReturnValue({
      authUserId: 'buyer_1',
      isAuthenticated: true,
      isPending: false,
      signIn: signInMock,
      signOut: vi.fn(),
    });
    apiPostMock.mockImplementation(() => new Promise(() => {}));
    const Component = GetInUnityRoute.options.component;
    if (!Component) throw new Error('Get in Unity component is missing');

    render(<Component />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByRole('button', { name: 'Verify purchase' }));

    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        '/api/connect/user/product-access/catalog_product_1',
        expect.objectContaining({ returnTo: expect.stringContaining('/get-in-unity/') })
      )
    );
    expect(screen.getByRole('button', { name: 'Starting verification...' })).toBeDisabled();
  });

  it('uses the durable creator-managed repository for an entitled buyer', async () => {
    loaderDataMock.mockReturnValue({
      ...productAccess,
      accessState: { hasActiveEntitlement: true, requiresVerification: false },
      repository: stableRepository,
    });
    vi.mocked(usePublicAuth).mockReturnValue({
      authUserId: 'buyer_1',
      isAuthenticated: true,
      isPending: false,
      signIn: signInMock,
      signOut: vi.fn(),
    });
    const Component = GetInUnityRoute.options.component;
    if (!Component) throw new Error('Get in Unity component is missing');

    render(<Component />, { wrapper: createWrapper() });

    expect(await screen.findByRole('button', { name: 'Add to VCC' })).toBeEnabled();
    expect(apiPostMock).not.toHaveBeenCalledWith('/api/vpm/repo-token');
    expect(screen.getByText(stableRepository.indexUrl)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download' })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="/api/access/"]')).not.toBeInTheDocument();
    expect(screen.getByText(/manual setup and troubleshooting/i)).toBeInTheDocument();
    expect(
      screen.getByText(
        'Add this product to VCC. The importer checks access and installs its files.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/protected files/i)).not.toBeInTheDocument();
  });

  it('keeps the same repository handoff after the authenticated buyer changes', async () => {
    loaderDataMock.mockReturnValue({
      ...productAccess,
      accessState: { hasActiveEntitlement: true, requiresVerification: false },
      repository: stableRepository,
    });
    vi.mocked(usePublicAuth).mockReturnValue({
      authUserId: 'buyer_1',
      isAuthenticated: true,
      isPending: false,
      signIn: signInMock,
      signOut: vi.fn(),
    });
    const Component = GetInUnityRoute.options.component;
    if (!Component) throw new Error('Get in Unity component is missing');
    const Wrapper = createWrapper();
    const rendered = render(<Component />, { wrapper: Wrapper });
    expect(await screen.findByText(stableRepository.indexUrl)).toBeInTheDocument();
    expect(apiPostMock).not.toHaveBeenCalled();

    vi.mocked(usePublicAuth).mockReturnValue({
      authUserId: 'buyer_2',
      isAuthenticated: true,
      isPending: false,
      signIn: signInMock,
      signOut: vi.fn(),
    });
    rendered.rerender(<Component />);

    expect(screen.getByText(stableRepository.indexUrl)).toBeInTheDocument();
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it('removes verification grants from the browser URL while preserving safe state', async () => {
    loaderDataMock.mockReturnValue({
      ...productAccess,
      accessState: { hasActiveEntitlement: true, requiresVerification: false },
      repository: stableRepository,
    });
    routeSearchMock.mockReturnValue({ grant: 'sensitive-grant', intent_id: 'intent-123' });
    vi.mocked(usePublicAuth).mockReturnValue({
      authUserId: 'buyer_1',
      isAuthenticated: true,
      isPending: false,
      signIn: signInMock,
      signOut: vi.fn(),
    });
    window.history.replaceState(
      {},
      '',
      '/get-in-unity/mapache/avatar-bundle?grant=sensitive-grant&intent_id=intent-123&tab=manual#setup'
    );
    const Component = GetInUnityRoute.options.component;
    if (!Component) throw new Error('Get in Unity component is missing');

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(window.location.search).toBe('?tab=manual'));
    expect(window.location.hash).toBe('#setup');
  });
});
