import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUYER_PROVIDER_LINK_SURFACE_MATRIX,
  createBuyerProviderLinkRecord,
  createBuyerProviderLinkStore,
} from '../../../../packages/shared/test/buyerProviderLinkInvariantMatrix';

const { toastErrorMock, toastSuccessMock, toastInfoMock, toastWarningMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  toastInfoMock: vi.fn(),
  toastWarningMock: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  createLazyFileRoute: () => (options: unknown) => ({ options }),
}));

vi.mock('@/components/ui/Toast', () => ({
  useToast: vi.fn(() => ({
    error: toastErrorMock,
    info: toastInfoMock,
    success: toastSuccessMock,
    warning: toastWarningMock,
  })),
}));

vi.mock('@/lib/dashboard', () => ({
  disconnectUserAccount: vi.fn(),
  getUserAccountsQueryKey: vi.fn(() => ['user-accounts', { refresh: false }] as const),
  listUserAccounts: vi.fn(),
  listUserProviders: vi.fn(),
  startUserVerify: vi.fn(),
}));

import * as dashboardApi from '@/lib/dashboard';
import { Route as AccountConnectionsRoute } from '../../src/routes/_authenticated/account/connections.lazy';

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

describe('account connections route', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();

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
        ...createBuyerProviderLinkStore([
          createBuyerProviderLinkRecord({
            id: 'buyer-link-vrchat-1',
            provider: 'vrchat',
            label: 'VRChat account',
            providerUserId: 'usr_vrchat_1',
            providerUsername: 'vrchat-user',
            providerDisplay: {
              label: 'VRChat',
              icon: 'VRChat.png',
              color: '#2563eb',
              description: 'Linked provider',
            },
          }),
        ]).listAccountConnections('buyer_auth_user_B')[0],
      },
    ]);

    vi.mocked(dashboardApi.disconnectUserAccount).mockResolvedValue({ success: true });
  });

  it('keeps existing linked providers visible so they can still be disconnected', async () => {
    const Component = AccountConnectionsRoute.options.component;
    if (!Component) {
      throw new Error('Account connections route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(dashboardApi.listUserProviders).toHaveBeenCalled());
    await waitFor(() => expect(dashboardApi.listUserAccounts).toHaveBeenCalled());

    const gumroadCard = (await screen.findByText('Gumroad')).closest('.acct-provider-row');
    if (!(gumroadCard instanceof HTMLElement)) {
      throw new Error('Gumroad card was not rendered');
    }
    expect(within(gumroadCard).getByRole('button', { name: 'Connect' })).toBeInTheDocument();

    const vrchatHandle = await screen.findByText('vrchat-user');
    const vrchatCard = vrchatHandle.closest('.acct-provider-row');
    if (!(vrchatCard instanceof HTMLElement)) {
      throw new Error('VRChat card was not rendered for the linked provider');
    }

    expect(within(vrchatCard).queryByRole('button', { name: 'Connect' })).toBeNull();

    fireEvent.click(within(vrchatCard).getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(within(vrchatCard).getByRole('button', { name: 'Yes' }));

    await waitFor(() =>
      expect(dashboardApi.disconnectUserAccount).toHaveBeenCalledWith('buyer-link-vrchat-1')
    );
  });

  for (const matrixCase of BUYER_PROVIDER_LINK_SURFACE_MATRIX.filter(
    (entry) => entry.expectVisible
  )) {
    it(`renders ${matrixCase.name} and updates the guidance counts after disconnect`, async () => {
      const store = createBuyerProviderLinkStore([
        createBuyerProviderLinkRecord({
          status: matrixCase.status,
        }),
      ]);
      vi.mocked(dashboardApi.listUserProviders).mockResolvedValue([
        {
          id: 'itchio',
          label: 'itch.io',
          icon: 'Itchio.png',
          color: '#fa5c5c',
          description: 'Linked provider',
        },
      ]);
      vi.mocked(dashboardApi.listUserAccounts).mockImplementation(async () =>
        store.listAccountConnections('buyer_auth_user_B')
      );
      vi.mocked(dashboardApi.disconnectUserAccount).mockImplementation(async (linkId: string) => ({
        success: store.revoke('buyer_auth_user_B', linkId),
      }));

      const Component = AccountConnectionsRoute.options.component;
      if (!Component) {
        throw new Error('Account connections route component is not defined');
      }

      render(<Component />, { wrapper: createWrapper() });

      const connectionHandle = await screen.findByText('buyer-b');
      const providerCard = connectionHandle.closest('.acct-provider-row');
      if (!(providerCard instanceof HTMLElement)) {
        throw new Error('Connected provider card was not rendered');
      }

      expect(within(providerCard).getByText('Verification')).toBeInTheDocument();
      expect(
        within(providerCard).getByText(matrixCase.status === 'expired' ? 'Expired' : 'Active')
      ).toBeInTheDocument();
      expect(screen.getByText('Active links').nextElementSibling).toHaveTextContent(
        String(matrixCase.expectedActiveCount)
      );
      expect(screen.getByText('Expired links').nextElementSibling).toHaveTextContent(
        String(matrixCase.expectedExpiredCount)
      );

      fireEvent.click(within(providerCard).getByRole('button', { name: 'Disconnect' }));
      fireEvent.click(within(providerCard).getByRole('button', { name: 'Yes' }));

      await waitFor(() =>
        expect(dashboardApi.disconnectUserAccount).toHaveBeenCalledWith(
          `buyer-link-${matrixCase.status}-1`
        )
      );
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument()
      );
      expect(screen.getByText('Active links').nextElementSibling).toHaveTextContent('0');
      expect(screen.getByText('Expired links').nextElementSibling).toHaveTextContent('0');
    });
  }

  it('keeps expired links visible while surfacing a reconnect action', async () => {
    const store = createBuyerProviderLinkStore([
      createBuyerProviderLinkRecord({
        status: 'expired',
      }),
    ]);
    vi.mocked(dashboardApi.listUserProviders).mockResolvedValue([
      {
        id: 'itchio',
        label: 'itch.io',
        icon: 'Itchio.png',
        color: '#fa5c5c',
        description: 'Linked provider',
      },
    ]);
    vi.mocked(dashboardApi.listUserAccounts).mockImplementation(async () =>
      store.listAccountConnections('buyer_auth_user_B')
    );

    const Component = AccountConnectionsRoute.options.component;
    if (!Component) {
      throw new Error('Account connections route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    const connectionHandle = await screen.findByText('buyer-b');
    const providerCard = connectionHandle.closest('.acct-provider-row');
    if (!(providerCard instanceof HTMLElement)) {
      throw new Error('Expired provider card was not rendered');
    }

    expect(within(providerCard).getByText('Needs attention')).toBeInTheDocument();
    expect(within(providerCard).getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(within(providerCard).queryByText('Connected')).toBeNull();
  });

  it('shows an inline error without also rendering the empty state when provider loading fails', async () => {
    vi.mocked(dashboardApi.listUserProviders).mockRejectedValue(new Error('provider fetch failed'));
    vi.mocked(dashboardApi.listUserAccounts).mockResolvedValue([]);

    const Component = AccountConnectionsRoute.options.component;
    if (!Component) {
      throw new Error('Account connections route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    expect(
      await screen.findByText('Failed to load account connections. Refresh to try again.')
    ).toBeInTheDocument();
    expect(screen.queryByText('No providers available')).toBeNull();
  });

  it('rejects malformed redirect protocols before navigation', async () => {
    vi.mocked(dashboardApi.listUserAccounts).mockResolvedValue([]);
    vi.mocked(dashboardApi.startUserVerify).mockResolvedValue({
      redirectUrl: 'javascript:alert(1)',
    });

    const initialHref = window.location.href;
    const Component = AccountConnectionsRoute.options.component;
    if (!Component) {
      throw new Error('Account connections route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    const [connectButton] = await screen.findAllByRole('button', { name: 'Connect' });
    if (!(connectButton instanceof HTMLButtonElement)) {
      throw new Error('Connect button was not rendered');
    }

    fireEvent.click(connectButton);

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith('Could not start connection', {
        description: 'Please try connecting Gumroad again.',
      })
    );
    expect(window.location.href).toBe(initialHref);
    expect(connectButton).toBeEnabled();
  });

  it('rejects absolute redirects to other origins before navigation', async () => {
    vi.mocked(dashboardApi.listUserAccounts).mockResolvedValue([]);
    vi.mocked(dashboardApi.startUserVerify).mockResolvedValue({
      redirectUrl: 'https://evil.example/phishing',
    });

    const initialHref = window.location.href;
    const Component = AccountConnectionsRoute.options.component;
    if (!Component) {
      throw new Error('Account connections route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    const [connectButton] = await screen.findAllByRole('button', { name: 'Connect' });
    if (!(connectButton instanceof HTMLButtonElement)) {
      throw new Error('Connect button was not rendered');
    }

    fireEvent.click(connectButton);

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith('Could not start connection', {
        description: 'Please try connecting Gumroad again.',
      })
    );
    expect(window.location.href).toBe(initialHref);
    expect(connectButton).toBeEnabled();
  });
});
