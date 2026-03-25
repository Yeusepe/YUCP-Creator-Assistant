import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockUseSearch = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  redirect: vi.fn(),
  useSearch: () => mockUseSearch(),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    signOut: vi.fn(),
  }),
}));

vi.mock('@/lib/account', () => ({
  getUserVerificationIntent: vi.fn(),
  verifyUserVerificationEntitlement: vi.fn(),
  verifyUserVerificationManualLicense: vi.fn(),
  verifyUserVerificationProviderLink: vi.fn(),
}));

vi.mock('@/lib/dashboard', async () => {
  const actual = await vi.importActual<typeof import('@/lib/dashboard')>('@/lib/dashboard');

  return {
    ...actual,
    listUserAccounts: vi.fn(),
    listUserProviders: vi.fn(),
    startUserVerify: vi.fn(),
  };
});

import * as accountApi from '@/lib/account';
import * as dashboardApi from '@/lib/dashboard';
import { Route as VerifyPurchaseRoute } from '@/routes/verify/purchase';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

describe('verify purchase route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSearch.mockReturnValue({
      intent: 'intent_gumroad_multi',
      connected: undefined,
    });

    vi.mocked(accountApi.getUserVerificationIntent).mockResolvedValue({
      object: 'verification_intent',
      id: 'intent_gumroad_multi',
      packageId: 'pkg-1',
      packageName: 'My Package',
      status: 'pending',
      verificationUrl: '/verify/purchase?intent=intent_gumroad_multi',
      returnUrl: 'https://localhost:3000/callback',
      requirements: [
        {
          methodKey: 'gumroad-oauth',
          providerKey: 'gumroad',
          providerLabel: 'Gumroad',
          kind: 'buyer_provider_link',
          title: 'Gumroad account',
          description: 'Connect the Gumroad account you purchased with.',
          creatorAuthUserId: 'creator-1',
          productId: 'product-1',
          providerProductRef: 'gumroad-product',
          capability: {
            methodKind: 'buyer_provider_link',
            completion: 'immediate',
            actionLabel: 'Sign in with Gumroad',
          },
        },
      ],
      verifiedMethodKey: null,
      errorCode: null,
      errorMessage: null,
      grantToken: null,
      grantAvailable: false,
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    vi.mocked(dashboardApi.listUserProviders).mockResolvedValue([
      {
        id: 'gumroad',
        label: 'Gumroad',
        icon: 'Gumroad.png',
        color: '#ff90e8',
        description: 'Store',
      },
    ]);

    vi.mocked(dashboardApi.listUserAccounts).mockResolvedValue([
      {
        id: 'gumroad-link-1',
        provider: 'gumroad',
        label: 'Main Gumroad',
        connectionType: 'verification',
        status: 'active',
        webhookConfigured: false,
        hasApiKey: false,
        hasAccessToken: false,
        providerUserId: 'gumroad-user-1',
        providerUsername: 'gumroad-main',
        verificationMethod: 'account_link',
        linkedAt: 10,
        lastValidatedAt: 12,
        expiresAt: null,
        createdAt: 10,
        updatedAt: 12,
      },
      {
        id: 'gumroad-link-2',
        provider: 'gumroad',
        label: 'Alt Gumroad',
        connectionType: 'verification',
        status: 'active',
        webhookConfigured: false,
        hasApiKey: false,
        hasAccessToken: false,
        providerUserId: 'gumroad-user-2',
        providerUsername: 'gumroad-alt',
        verificationMethod: 'account_link',
        linkedAt: 20,
        lastValidatedAt: 22,
        expiresAt: null,
        createdAt: 20,
        updatedAt: 22,
      },
    ]);
  });

  it('shows all linked provider accounts for a verification method instead of collapsing to one', async () => {
    const Component = VerifyPurchaseRoute.options.component;
    if (!Component) {
      throw new Error('Verify purchase route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(accountApi.getUserVerificationIntent).toHaveBeenCalled());
    await waitFor(() => expect(dashboardApi.listUserAccounts).toHaveBeenCalled());

    expect(await screen.findByText(/gumroad-main/i)).toBeInTheDocument();
    expect(await screen.findByText(/gumroad-alt/i)).toBeInTheDocument();
  });

  it('shows a loading button while linked accounts are still loading', async () => {
    const deferredAccounts =
      createDeferred<Awaited<ReturnType<typeof dashboardApi.listUserAccounts>>>();
    vi.mocked(dashboardApi.listUserAccounts).mockReturnValue(deferredAccounts.promise);

    const Component = VerifyPurchaseRoute.options.component;
    if (!Component) {
      throw new Error('Verify purchase route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(accountApi.getUserVerificationIntent).toHaveBeenCalled());
    await waitFor(() => expect(dashboardApi.listUserProviders).toHaveBeenCalled());
    await waitFor(() => expect(dashboardApi.listUserAccounts).toHaveBeenCalled());

    expect(await screen.findByRole('button', { name: /loading/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^sign in$/i })).not.toBeInTheDocument();

    deferredAccounts.resolve([]);
  });
});
