import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentPropsWithoutRef, PropsWithChildren, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockUseParams = vi.fn();
const mockUseSearch = vi.fn();

type MockLinkProps = ComponentPropsWithoutRef<'a'> & {
  children?: ReactNode;
  search?: unknown;
  to?: unknown;
};

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, search: _search, to: _to, ...props }: MockLinkProps) => (
    <a {...props}>{children}</a>
  ),
  createFileRoute: () => (options: unknown) => ({
    options,
    useParams: () => mockUseParams(),
    useSearch: () => mockUseSearch(),
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

vi.mock('@/lib/packages', () => ({
  requestBackstageRepoAccess: vi.fn(),
}));

vi.mock('@/lib/productAccess', () => ({
  createBuyerProductAccessVerificationIntent: vi.fn(),
  getBuyerProductAccess: vi.fn(),
}));

import * as packagesApi from '@/lib/packages';
import * as productAccessApi from '@/lib/productAccess';
import { Route as BuyerProductAccessRoute } from '../../src/routes/access.$catalogProductId';

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
  beforeEach(() => {
    vi.resetAllMocks();
    mockUseParams.mockReturnValue({ catalogProductId: 'catalog_123' });
    mockUseSearch.mockReturnValue({});
    mockAuthState.isAuthenticated = true;
    mockAuthState.isPending = false;
  });

  afterEach(() => {
    cleanup();
  });

  it('shows purchase verification as the primary buyer action before access is unlocked', async () => {
    vi.mocked(productAccessApi.getBuyerProductAccess).mockResolvedValue({
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
            repositoryVisibility: 'hidden',
          },
        ],
      },
      accessState: {
        hasActiveEntitlement: false,
        requiresVerification: true,
        hasPublishedPackages: true,
      },
    });
    vi.mocked(productAccessApi.createBuyerProductAccessVerificationIntent).mockResolvedValue({
      verificationUrl: 'http://localhost:3000/verify/purchase?intent=intent_123',
    });

    const Component = BuyerProductAccessRoute.options.component;
    if (!Component) {
      throw new Error('Buyer product access route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    expect(await screen.findByRole('heading', { name: 'Avatar Bundle' })).toBeInTheDocument();
    expect(await screen.findByText('Bought on Gumroad')).toBeInTheDocument();
    expect((await screen.findAllByText('1 Unity package')).length).toBeGreaterThan(0);
    const verifyButton = await screen.findByRole('button', { name: 'Verify purchase' });
    fireEvent.click(verifyButton);

    await waitFor(() =>
      expect(productAccessApi.createBuyerProductAccessVerificationIntent).toHaveBeenCalledWith(
        'catalog_123',
        { returnTo: '/access/catalog_123' }
      )
    );
    expect(await screen.findByText(/verify the store account or license/i)).toBeInTheDocument();
    expect(
      await screen.findByText(
        /manual repo setup stays hidden until this account has verified access/i
      )
    ).toBeInTheDocument();
  });

  it('asks the buyer to sign in before starting verification when the route is opened anonymously', async () => {
    mockAuthState.isAuthenticated = false;
    vi.mocked(productAccessApi.getBuyerProductAccess).mockResolvedValue({
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
            repositoryVisibility: 'hidden',
          },
        ],
      },
      accessState: {
        hasActiveEntitlement: false,
        requiresVerification: true,
        hasPublishedPackages: true,
      },
    });

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
    vi.mocked(productAccessApi.getBuyerProductAccess).mockResolvedValue({
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
            repositoryVisibility: 'hidden',
          },
        ],
      },
      accessState: {
        hasActiveEntitlement: true,
        requiresVerification: false,
        hasPublishedPackages: true,
      },
    });
    vi.mocked(packagesApi.requestBackstageRepoAccess).mockResolvedValue({
      addRepoUrl: 'vcc://addRepo',
      repositoryUrl: 'https://repo.test/private.json',
    } as Awaited<ReturnType<typeof packagesApi.requestBackstageRepoAccess>>);
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
    expect(await screen.findByText('Owned product context')).toBeInTheDocument();
    expect(screen.queryByText('https://repo.test/private.json')).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: /show manual setup/i }));

    expect(await screen.findByText('https://repo.test/private.json')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Copy repo URL' }));

    await waitFor(() =>
      expect(window.navigator.clipboard.writeText).toHaveBeenCalledWith(
        'https://repo.test/private.json'
      )
    );
    expect(toastSuccessMock).toHaveBeenCalledWith('Repo URL copied');
  });
});
