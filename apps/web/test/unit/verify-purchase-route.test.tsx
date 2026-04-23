import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockUseSearch = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  createLazyFileRoute: () => (options: unknown) => ({ options }),
  redirect: vi.fn(),
  useSearch: () => mockUseSearch(),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    signOut: vi.fn(),
  }),
}));

vi.mock('@/components/three/CloudBackground', () => ({
  CloudBackground: ({ variant }: { variant?: 'default' | '404' }) => (
    <div data-testid="cloud-background" data-variant={variant ?? 'default'} />
  ),
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
import { Route as VerifyPurchaseRoute } from '@/routes/_authenticated/verify/purchase.lazy';

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
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.resetAllMocks();
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

    expect(await screen.findByLabelText('Loading store connections')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^sign in$/i })).not.toBeInTheDocument();

    deferredAccounts.resolve([]);
  });

  it('rejects invalid provider redirects before navigation', async () => {
    vi.mocked(dashboardApi.listUserAccounts).mockResolvedValue([]);
    vi.mocked(dashboardApi.startUserVerify).mockResolvedValue({
      redirectUrl: 'https://evil.example/phishing',
    });

    const initialHref = window.location.href;
    const Component = VerifyPurchaseRoute.options.component;
    if (!Component) {
      throw new Error('Verify purchase route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    const signInButton = await screen.findByRole('button', { name: 'Sign in' });
    fireEvent.click(signInButton);

    await waitFor(() =>
      expect(screen.getByText('Could not connect, please try again')).toBeInTheDocument()
    );
    expect(window.location.href).toBe(initialHref);
    expect(signInButton).toBeEnabled();
  });

  it('renders the shared cloud background like the dashboard shell', async () => {
    const Component = VerifyPurchaseRoute.options.component;
    if (!Component) {
      throw new Error('Verify purchase route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    expect(
      screen
        .getAllByTestId('cloud-background')
        .every((element) => element.getAttribute('data-variant') === 'default')
    ).toBe(true);
  });

  it('auto-verifies the returned provider after an OAuth redirect', async () => {
    mockUseSearch.mockReturnValue({
      intent: 'intent_discord_oauth_return',
      connected: 'discord',
    });

    vi.mocked(accountApi.getUserVerificationIntent).mockResolvedValue({
      object: 'verification_intent',
      id: 'intent_discord_oauth_return',
      packageId: 'pkg-discord-1',
      packageName: 'Discord Package',
      status: 'pending',
      verificationUrl: '/verify/purchase?intent=intent_discord_oauth_return',
      returnUrl: 'https://localhost:3000/callback',
      requirements: [
        {
          methodKey: 'discord-account-link',
          providerKey: 'discord',
          providerLabel: 'Discord',
          kind: 'buyer_provider_link',
          title: 'Discord account',
          description: 'Connect the Discord account you used to verify.',
          creatorAuthUserId: 'creator-1',
          productId: 'product-discord-1',
          providerProductRef: 'discord-role',
          capability: {
            methodKind: 'buyer_provider_link',
            completion: 'immediate',
            actionLabel: 'Sign in with Discord',
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
        id: 'discord',
        label: 'Discord',
        icon: 'Discord.png',
        color: '#5865F2',
        description: 'Community',
      },
    ]);

    vi.mocked(dashboardApi.listUserAccounts).mockResolvedValue([]);
    vi.mocked(accountApi.verifyUserVerificationProviderLink).mockResolvedValue({ success: true });

    const Component = VerifyPurchaseRoute.options.component;
    if (!Component) {
      throw new Error('Verify purchase route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(accountApi.verifyUserVerificationProviderLink).toHaveBeenCalledWith(
        'intent_discord_oauth_return',
        'discord-account-link'
      )
    );
  });

  it('refreshes the intent after an OAuth return fails so the no-purchase banner becomes visible immediately', async () => {
    mockUseSearch.mockReturnValue({
      intent: 'intent_itchio_no_purchase',
      connected: 'itchio',
    });

    vi.mocked(accountApi.getUserVerificationIntent)
      .mockResolvedValueOnce({
        object: 'verification_intent',
        id: 'intent_itchio_no_purchase',
        packageId: 'pkg-itchio-1',
        packageName: 'itch.io Package',
        status: 'pending',
        verificationUrl: '/verify/purchase?intent=intent_itchio_no_purchase',
        returnUrl: 'https://localhost:3000/callback',
        requirements: [
          {
            methodKey: 'itchio-oauth',
            providerKey: 'itchio',
            providerLabel: 'itch.io',
            kind: 'buyer_provider_link',
            title: 'itch.io account',
            description: 'Connect the itch.io account you purchased with.',
            creatorAuthUserId: 'creator-1',
            productId: 'product-itchio-1',
            providerProductRef: 'itchio-game-1',
            capability: {
              methodKind: 'buyer_provider_link',
              completion: 'immediate',
              actionLabel: 'Sign in with itch.io',
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
      })
      .mockResolvedValueOnce({
        object: 'verification_intent',
        id: 'intent_itchio_no_purchase',
        packageId: 'pkg-itchio-1',
        packageName: 'itch.io Package',
        status: 'failed',
        verificationUrl: '/verify/purchase?intent=intent_itchio_no_purchase',
        returnUrl: 'https://localhost:3000/callback',
        requirements: [
          {
            methodKey: 'itchio-oauth',
            providerKey: 'itchio',
            providerLabel: 'itch.io',
            kind: 'buyer_provider_link',
            title: 'itch.io account',
            description: 'Connect the itch.io account you purchased with.',
            creatorAuthUserId: 'creator-1',
            productId: 'product-itchio-1',
            providerProductRef: 'itchio-game-1',
            capability: {
              methodKind: 'buyer_provider_link',
              completion: 'immediate',
              actionLabel: 'Sign in with itch.io',
            },
          },
        ],
        verifiedMethodKey: null,
        errorCode: 'purchase_not_found',
        errorMessage:
          'No purchase was found for this itch.io account. If you just bought, please try again in a moment.',
        grantToken: null,
        grantAvailable: false,
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

    vi.mocked(dashboardApi.listUserProviders).mockResolvedValue([
      {
        id: 'itchio',
        label: 'itch.io',
        icon: 'Itchio.png',
        color: '#fa5c5c',
        description: 'Store',
      },
    ]);
    vi.mocked(dashboardApi.listUserAccounts).mockResolvedValue([
      {
        id: 'itchio-link-1',
        provider: 'itchio',
        label: 'Main itch.io',
        connectionType: 'verification',
        status: 'active',
        webhookConfigured: false,
        hasApiKey: false,
        hasAccessToken: true,
        providerUserId: 'itchio-user-1',
        providerUsername: 'itch-buyer',
        verificationMethod: 'account_link',
        linkedAt: 10,
        lastValidatedAt: 12,
        expiresAt: null,
        createdAt: 10,
        updatedAt: 12,
      },
    ]);
    vi.mocked(accountApi.verifyUserVerificationProviderLink).mockRejectedValue(
      new Error(
        'No purchase was found for this itch.io account. If you just bought, please try again in a moment.'
      )
    );

    const Component = VerifyPurchaseRoute.options.component;
    if (!Component) {
      throw new Error('Verify purchase route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(accountApi.verifyUserVerificationProviderLink).toHaveBeenCalledWith(
        'intent_itchio_no_purchase',
        'itchio-oauth'
      )
    );
    await waitFor(() => expect(accountApi.getUserVerificationIntent).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText(
        'No purchase was found for this itch.io account. If you just bought, please try again in a moment.'
      )
    ).toBeInTheDocument();
  });

  it('shows linked non-OAuth providers in the sign-in section when an account is already synced', async () => {
    mockUseSearch.mockReturnValue({
      intent: 'intent_jinxxy_linked',
      connected: undefined,
    });

    vi.mocked(accountApi.getUserVerificationIntent).mockResolvedValue({
      object: 'verification_intent',
      id: 'intent_jinxxy_linked',
      packageId: 'pkg-jinxxy-1',
      packageName: 'Jinxxy Package',
      status: 'pending',
      verificationUrl: '/verify/purchase?intent=intent_jinxxy_linked',
      returnUrl: 'https://localhost:3000/callback',
      requirements: [
        {
          methodKey: 'jinxxy-entitlement',
          providerKey: 'jinxxy',
          providerLabel: 'Jinxxy',
          kind: 'existing_entitlement',
          title: 'Jinxxy access',
          description: 'Use your linked Jinxxy account to verify access.',
          creatorAuthUserId: 'creator-1',
          productId: 'product-jinxxy-1',
          providerProductRef: null,
          capability: {
            methodKind: 'existing_entitlement',
            completion: 'immediate',
            actionLabel: 'Check access',
          },
        },
        {
          methodKey: 'jinxxy-license',
          providerKey: 'jinxxy',
          providerLabel: 'Jinxxy',
          kind: 'manual_license',
          title: 'Jinxxy license',
          description: 'Enter your Jinxxy license key.',
          creatorAuthUserId: null,
          productId: null,
          providerProductRef: 'jinxxy-product-1',
          capability: {
            methodKind: 'manual_license',
            completion: 'immediate',
            actionLabel: 'Verify',
            input: {
              kind: 'license_key',
              label: 'License key',
              placeholder: 'Enter license key',
              masked: false,
              submitLabel: 'Verify',
            },
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
        id: 'jinxxy',
        label: 'Jinxxy',
        icon: 'Jinxxy.png',
        color: '#5a8cff',
        description: 'Store',
      },
    ]);

    vi.mocked(dashboardApi.listUserAccounts).mockResolvedValue([
      {
        id: 'jinxxy-link-1',
        provider: 'jinxxy',
        label: 'Main Jinxxy',
        connectionType: 'verification',
        status: 'active',
        webhookConfigured: false,
        hasApiKey: false,
        hasAccessToken: false,
        providerUserId: 'jinxxy-user-1',
        providerUsername: 'jinxxy-main',
        verificationMethod: 'account_link',
        linkedAt: 10,
        lastValidatedAt: 12,
        expiresAt: null,
        createdAt: 10,
        updatedAt: 12,
      },
    ]);

    const Component = VerifyPurchaseRoute.options.component;
    if (!Component) {
      throw new Error('Verify purchase route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(accountApi.getUserVerificationIntent).toHaveBeenCalled());
    await waitFor(() => expect(dashboardApi.listUserAccounts).toHaveBeenCalled());

    expect((await screen.findAllByText(/sign in to verify/i)).length).toBeGreaterThan(0);
    expect(await screen.findByText(/jinxxy-main/i)).toBeInTheDocument();
    expect(
      (await screen.findAllByRole('button', { name: /verify purchase/i })).length
    ).toBeGreaterThan(0);
  });
});
