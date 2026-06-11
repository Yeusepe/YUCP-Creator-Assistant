import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentPropsWithoutRef, PropsWithChildren, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockUseParams = vi.fn();
const mockUseSearch = vi.fn();
const mockUseLoaderData = vi.fn();

type MockLinkProps = ComponentPropsWithoutRef<'a'> & {
  children?: ReactNode;
  search?: unknown;
  to?: unknown;
};

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, search: _search, to: _to, ...props }: MockLinkProps) => (
    <a {...props}>{children}</a>
  ),
  getRouteApi: () => ({
    useParams: () => mockUseParams(),
    useSearch: () => mockUseSearch(),
    useLoaderData: () => mockUseLoaderData(),
  }),
  createFileRoute: () => (options: unknown) => ({
    options,
    useParams: () => mockUseParams(),
    useSearch: () => mockUseSearch(),
    useLoaderData: () => mockUseLoaderData(),
  }),
  createLazyFileRoute: () => (options: unknown) => ({ options }),
}));

vi.mock('@/components/three/CloudBackground', () => ({
  CloudBackground: ({ variant }: { variant?: 'default' | '404' }) => (
    <div data-testid="cloud-background" data-variant={variant ?? 'default'} />
  ),
}));

const signInMock = vi.fn();
const mockAuthState = {
  isAuthenticated: true,
  isPending: false,
};

vi.mock('@/hooks/usePublicAuth', () => ({
  usePublicAuth: () => ({
    isAuthenticated: mockAuthState.isAuthenticated,
    isPending: mockAuthState.isPending,
    signIn: signInMock,
  }),
}));

const toastErrorMock = vi.fn();
const toastSuccessMock = vi.fn();

vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({
    error: toastErrorMock,
    success: toastSuccessMock,
  }),
}));

vi.mock('@/components/ui/YucpButton', () => ({
  YucpButton: ({
    children,
    isDisabled,
    isLoading,
    onPress,
  }: PropsWithChildren<{
    isDisabled?: boolean;
    isLoading?: boolean;
    onPress?: () => void;
  }>) => (
    <button disabled={Boolean(isDisabled || isLoading)} onClick={() => onPress?.()} type="button">
      {children}
    </button>
  ),
}));

vi.mock('@/lib/backstageAccess', () => ({
  redeemBuyerBackstageVerificationIntent: vi.fn(),
  requestUserBackstageRepoAccess: vi.fn(),
}));

vi.mock('@/lib/productAccess', () => ({
  createBuyerProductAccessVerificationIntent: vi.fn(),
}));

import * as backstageAccessApi from '@/lib/backstageAccess';
import * as productAccessApi from '@/lib/productAccess';
import { fetchBuyerProductAccess } from '@/lib/server/productAccess';
import { Route as BuyerProductAccessRoute } from '../../src/routes/access.$catalogProductId';

vi.mock('@/lib/server/productAccess', () => ({
  fetchBuyerProductAccess: vi.fn(),
}));

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

describe('buyer product access route', () => {
  const buyerAccessResponse = {
    product: {
      catalogProductId: 'catalog_123',
      displayName: 'Avatar Bundle',
      canonicalSlug: 'avatar-bundle',
      thumbnailUrl: null,
      provider: 'gumroad',
      providerLabel: 'Gumroad',
      storefrontUrl: 'https://store.test/product',
      accessPagePath: '/access/catalog_123',
      packagePreview: [
        {
          packageId: 'com.yucp.avatar.bundle',
          packageName: null,
          displayName: 'Avatar Bundle',
          defaultChannel: null,
          latestPublishedVersion: '1.2.0',
          latestPublishedAt: null,
          repositoryVisibility: 'hidden' as const,
        },
      ],
    },
    accessState: {
      hasActiveEntitlement: false,
      requiresVerification: true,
      hasPublishedPackages: true,
    },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    window.sessionStorage.clear();
    window.history.replaceState({}, '', 'http://localhost:3000/access/catalog_123');
    mockUseParams.mockReturnValue({ catalogProductId: 'catalog_123' });
    mockUseSearch.mockReturnValue({});
    mockUseLoaderData.mockReturnValue(buyerAccessResponse);
    mockAuthState.isAuthenticated = true;
    mockAuthState.isPending = false;
  });

  afterEach(() => {
    cleanup();
  });

  it('shows purchase verification as the primary buyer action before access is unlocked', async () => {
    vi.mocked(productAccessApi.createBuyerProductAccessVerificationIntent).mockResolvedValue({
      intentId: 'intent_123',
      codeVerifier: 'verifier_123',
      machineFingerprint: 'buyer-access-web:0123456789abcdef0123456789abcdef',
      verificationUrl: 'http://localhost:3000/verify/purchase?intent=intent_123',
    });

    const Component = BuyerProductAccessRoute.options.component;
    if (!Component) {
      throw new Error('Buyer product access route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    expect(await screen.findByRole('heading', { name: 'Avatar Bundle' })).toBeInTheDocument();
    expect(await screen.findByText(/Purchase source:/)).toBeInTheDocument();
    expect((await screen.findAllByText(/Gumroad/)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('1 Unity package')).length).toBeGreaterThan(0);
    const verifyButton = await screen.findByRole('button', { name: 'Verify purchase' });
    fireEvent.click(verifyButton);

    await waitFor(() =>
      expect(productAccessApi.createBuyerProductAccessVerificationIntent).toHaveBeenCalledWith(
        'catalog_123',
        { returnTo: '/access/catalog_123' }
      )
    );
    expect(
      JSON.parse(
        window.sessionStorage.getItem('yucp:buyer-product-access-verification:intent_123') ?? '{}'
      )
    ).toEqual({
      catalogProductId: 'catalog_123',
      codeVerifier: 'verifier_123',
      machineFingerprint: 'buyer-access-web:0123456789abcdef0123456789abcdef',
    });
    expect(
      await screen.findByText(/Use the Gumroad account or license details/i)
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add to VCC' })).not.toBeInTheDocument();
  });

  it('redeems hosted verification grants and prepares VCC access when the buyer returns', async () => {
    window.history.replaceState(
      {},
      '',
      'http://localhost:3000/access/catalog_123?grant=grant-token&intent_id=intent_123'
    );
    mockUseSearch.mockReturnValue({ grant: 'grant-token', intent_id: 'intent_123' });
    window.sessionStorage.setItem(
      'yucp:buyer-product-access-verification:intent_123',
      JSON.stringify({
        catalogProductId: 'catalog_123',
        codeVerifier: 'verifier_123',
        machineFingerprint: 'buyer-access-web:0123456789abcdef0123456789abcdef',
      })
    );
    vi.mocked(backstageAccessApi.redeemBuyerBackstageVerificationIntent).mockResolvedValue({
      success: true,
      token: 'license.jwt',
      expiresAt: 123,
    });
    vi.mocked(backstageAccessApi.requestUserBackstageRepoAccess).mockResolvedValue({
      addRepoUrl: 'vcc://addRepo',
      repositoryUrl: 'https://repo.test/private.json',
    } as Awaited<ReturnType<typeof backstageAccessApi.requestUserBackstageRepoAccess>>);

    const Component = BuyerProductAccessRoute.options.component;
    if (!Component) {
      throw new Error('Buyer product access route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(backstageAccessApi.redeemBuyerBackstageVerificationIntent).toHaveBeenCalledWith({
        intentId: 'intent_123',
        grantToken: 'grant-token',
        codeVerifier: 'verifier_123',
        machineFingerprint: 'buyer-access-web:0123456789abcdef0123456789abcdef',
      })
    );
    await waitFor(() =>
      expect(backstageAccessApi.requestUserBackstageRepoAccess).toHaveBeenCalledWith({
        catalogProductId: 'catalog_123',
      })
    );
    expect(await screen.findByRole('button', { name: 'Add to VCC' })).toBeInTheDocument();
    expect(
      window.sessionStorage.getItem('yucp:buyer-product-access-verification:intent_123')
    ).toBeNull();
    expect(window.location.search).toBe('');
  });

  it('asks the buyer to sign in before starting verification when the route is opened anonymously', async () => {
    mockAuthState.isAuthenticated = false;

    const Component = BuyerProductAccessRoute.options.component;
    if (!Component) {
      throw new Error('Buyer product access route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    const signInButton = await screen.findByRole('button', { name: 'Sign in to continue' });
    fireEvent.click(signInButton);

    await waitFor(() => expect(signInMock).toHaveBeenCalledWith(window.location.href));
    expect(productAccessApi.createBuyerProductAccessVerificationIntent).not.toHaveBeenCalled();
  });

  it('prioritizes Add to VCC and keeps manual repo details hidden until expanded', async () => {
    mockUseLoaderData.mockReturnValue({
      ...buyerAccessResponse,
      accessState: {
        hasActiveEntitlement: true,
        requiresVerification: false,
        hasPublishedPackages: true,
      },
    });
    vi.mocked(backstageAccessApi.requestUserBackstageRepoAccess).mockResolvedValue({
      addRepoUrl: 'vcc://addRepo',
      repositoryUrl: 'https://repo.test/private.json',
    } as Awaited<ReturnType<typeof backstageAccessApi.requestUserBackstageRepoAccess>>);
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });

    const Component = BuyerProductAccessRoute.options.component;
    if (!Component) {
      throw new Error('Buyer product access route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    expect(await screen.findByRole('button', { name: 'Add to VCC' })).toBeInTheDocument();
    expect(backstageAccessApi.requestUserBackstageRepoAccess).toHaveBeenCalledWith({
      catalogProductId: 'catalog_123',
    });
    expect(await screen.findByText('Need help adding to VCC?')).toBeInTheDocument();
    const repoUrl = screen.getByText('https://repo.test/private.json');
    expect(repoUrl.closest('.vp-manual-setup-panel')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(await screen.findByRole('button', { name: /manual setup/i }));

    expect(repoUrl.closest('.vp-manual-setup-panel')).toHaveAttribute('aria-hidden', 'false');

    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));

    await waitFor(() =>
      expect(window.navigator.clipboard.writeText).toHaveBeenCalledWith(
        'https://repo.test/private.json'
      )
    );
    expect(toastSuccessMock).toHaveBeenCalledWith('Repo URL copied');
  });

  it('loads buyer access through the route loader before render', async () => {
    const loader = BuyerProductAccessRoute.options.loader;
    if (!loader) {
      throw new Error('Buyer product access route loader is not defined');
    }

    vi.mocked(fetchBuyerProductAccess).mockResolvedValue(buyerAccessResponse);

    const result = await loader({
      params: { catalogProductId: 'catalog_123' },
    } as never);

    expect(fetchBuyerProductAccess).toHaveBeenCalledWith({
      data: {
        catalogProductId: 'catalog_123',
      },
    });
    expect(result).toEqual(buyerAccessResponse);
  });
});
