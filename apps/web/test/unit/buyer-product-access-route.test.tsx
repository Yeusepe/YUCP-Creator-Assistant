import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useLoaderDataMock = vi.hoisted(() => vi.fn());
const useSearchMock = vi.hoisted(() => vi.fn(() => ({ grant: undefined, intent_id: undefined })));
const mintBuyerVpmRepositoryMock = vi.hoisted(() => vi.fn());
const copyToClipboardMock = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({
    options,
    useLoaderData: useLoaderDataMock,
    useSearch: useSearchMock,
  }),
  Link: ({ children }: PropsWithChildren) => <a href="/account/licenses">{children}</a>,
}));

vi.mock('@/components/three/CloudBackground', () => ({
  CloudBackground: () => null,
}));

vi.mock('@/lib/server/productAccess', () => ({
  fetchBuyerProductAccess: vi.fn(),
}));

vi.mock('@/lib/productAccess', () => ({
  createBuyerProductAccessVerificationIntent: vi.fn(),
  mintBuyerVpmRepository: mintBuyerVpmRepositoryMock,
}));

vi.mock('@/hooks/usePublicAuth', () => ({
  usePublicAuth: () => ({
    authUserId: 'buyer-user-1',
    isAuthenticated: true,
    isPending: false,
    signIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));

vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }),
}));

vi.mock('@/lib/utils', () => ({
  copyToClipboard: copyToClipboardMock,
}));

import { Route as BuyerProductAccessRoute } from '@/routes/access.$catalogProductId';

const repository = {
  token: 'buyer-token',
  indexUrl: 'https://vpm.test/api/vpm/buyer-token/index.json',
  addRepoUrl: 'vcc://vpm/addRepo?url=https%3A%2F%2Fvpm.test%2Fapi%2Fvpm%2Fbuyer-token%2Findex.json',
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('buyer product access route', () => {
  beforeEach(() => {
    cleanup();
    useSearchMock.mockReturnValue({ grant: undefined, intent_id: undefined });
    mintBuyerVpmRepositoryMock.mockReset();
    mintBuyerVpmRepositoryMock.mockResolvedValue(repository);
    copyToClipboardMock.mockReset();
  });

  it('offers the local signed-download endpoint to entitled buyers', () => {
    const Component = BuyerProductAccessRoute.options.component;
    if (!Component) {
      throw new Error('Buyer product access route component is not defined');
    }

    useLoaderDataMock.mockReturnValue({
      product: {
        catalogProductId: 'catalog/product',
        displayName: 'Avatar Bundle',
        canonicalSlug: null,
        thumbnailUrl: null,
        provider: 'gumroad',
        providerLabel: 'Gumroad',
        storefrontUrl: null,
      },
      accessState: {
        hasActiveEntitlement: true,
        requiresVerification: false,
      },
    });

    render(<Component />, { wrapper: createWrapper() });

    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      '/api/access/catalog%2Fproduct/download'
    );
  });

  it('mints and shows the buyer VPM handoff with a copyable index URL', async () => {
    const Component = BuyerProductAccessRoute.options.component;
    if (!Component) {
      throw new Error('Buyer product access route component is not defined');
    }
    useLoaderDataMock.mockReturnValue({
      product: {
        catalogProductId: 'catalog/product',
        displayName: 'Avatar Bundle',
        canonicalSlug: null,
        thumbnailUrl: null,
        provider: 'gumroad',
        providerLabel: 'Gumroad',
        storefrontUrl: null,
      },
      accessState: {
        hasActiveEntitlement: true,
        requiresVerification: false,
      },
    });
    mintBuyerVpmRepositoryMock.mockResolvedValue(repository);
    copyToClipboardMock.mockResolvedValue(true);

    render(<Component />, { wrapper: createWrapper() });

    const addRepoButton = await screen.findByRole('button', { name: 'Add to VCC' });
    expect(addRepoButton).toBeEnabled();
    expect(screen.getByText('https://vpm.test/api/vpm/buyer-token/index.json')).toBeVisible();
    expect(
      screen.getByText(
        'vcc://vpm/addRepo?url=https%3A%2F%2Fvpm.test%2Fapi%2Fvpm%2Fbuyer-token%2Findex.json'
      )
    ).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Manual setup and troubleshooting' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[1]);
    await waitFor(() => {
      expect(copyToClipboardMock).toHaveBeenCalledWith(
        'https://vpm.test/api/vpm/buyer-token/index.json'
      );
    });
  });
});
