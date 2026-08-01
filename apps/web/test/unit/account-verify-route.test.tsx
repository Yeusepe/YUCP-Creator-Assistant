import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockUseSearch = vi.fn();

const { toastErrorMock, toastInfoMock, toastSuccessMock, toastWarningMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn(),
  toastInfoMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  toastWarningMock: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  createLazyFileRoute: () => (options: unknown) => ({ options }),
  useSearch: () => mockUseSearch(),
}));

vi.mock('@/components/ui/Toast', () => ({
  useToast: vi.fn(() => ({
    error: toastErrorMock,
    info: toastInfoMock,
    success: toastSuccessMock,
    warning: toastWarningMock,
  })),
}));

vi.mock('@/lib/account', () => ({
  formatAccountDateTime: vi.fn(() => 'Jan 1, 2025'),
  getUserVerificationIntent: vi.fn(),
  verifyUserVerificationEntitlement: vi.fn(),
  verifyUserVerificationManualLicense: vi.fn(),
  verifyUserVerificationProviderLink: vi.fn(),
}));

vi.mock('@/lib/dashboard', () => ({
  getUserAccountsQueryKey: vi.fn(() => ['account-user-accounts']),
  listUserAccounts: vi.fn(),
  listUserProviders: vi.fn(),
  startUserVerify: vi.fn(),
}));

import * as accountApi from '@/lib/account';
import * as dashboardApi from '@/lib/dashboard';
import { Route as AccountVerifyRoute } from '@/routes/_authenticated/account/verify.lazy';

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

describe('account verify route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSearch.mockReturnValue({ intent: 'intent-1' });

    vi.mocked(accountApi.getUserVerificationIntent).mockResolvedValue({
      object: 'verification_intent',
      id: 'intent-1',
      packageId: 'pkg-1',
      packageName: 'Avatar Package',
      status: 'pending',
      verificationUrl: '/account/verify?intent=intent-1',
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

    vi.mocked(dashboardApi.listUserAccounts).mockResolvedValue([]);
  });

  it('rejects invalid provider redirects before navigation', async () => {
    vi.mocked(dashboardApi.startUserVerify).mockResolvedValue({
      redirectUrl: 'https://evil.example/phishing',
    });

    const initialHref = window.location.href;
    const Component = AccountVerifyRoute.options.component;
    if (!Component) {
      throw new Error('Account verify route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    const connectButton = await screen.findByRole('button', { name: 'Connect Gumroad' });
    fireEvent.click(connectButton);

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith('We couldn’t connect this store', {
        description: 'Unsupported redirect target',
      })
    );
    expect(window.location.href).toBe(initialHref);
    expect(connectButton).toBeEnabled();
  });

  it('uses plain verification language instead of protocol terms and raw status values', async () => {
    const Component = AccountVerifyRoute.options.component;
    if (!Component) {
      throw new Error('Account verify route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    expect(
      await screen.findAllByText(
        'Confirm your purchase here. Unity will continue when the product is ready to install.'
      )
    ).not.toHaveLength(0);
    expect(screen.getByText('Waiting for verification')).toBeInTheDocument();
    expect(screen.queryByText('pending')).not.toBeInTheDocument();
    expect(screen.queryByText('buyer_provider_link')).not.toBeInTheDocument();
    expect(screen.queryByText(/verification grant/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/machine-bound token/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/code challenge/i)).not.toBeInTheDocument();
  });

  it('does not use a raw provider account identifier as the linked account label', async () => {
    vi.mocked(dashboardApi.listUserAccounts).mockResolvedValue([
      {
        id: 'gumroad-link-raw',
        provider: 'gumroad',
        label: '',
        connectionType: 'verification',
        status: 'active',
        webhookConfigured: false,
        hasApiKey: false,
        hasAccessToken: false,
        providerUserId: 'raw-provider-user-1738',
        providerUsername: null,
        verificationMethod: 'account_link',
        linkedAt: 10,
        lastValidatedAt: 12,
        expiresAt: null,
        createdAt: 10,
        updatedAt: 12,
      },
    ]);
    const Component = AccountVerifyRoute.options.component;
    if (!Component) {
      throw new Error('Account verify route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    expect(await screen.findByText('Connected store account')).toBeInTheDocument();
    expect(screen.queryByText('raw-provider-user-1738')).not.toBeInTheDocument();
  });
});
