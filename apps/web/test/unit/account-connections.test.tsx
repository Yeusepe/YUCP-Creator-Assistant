import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));

vi.mock('@/components/ui/Toast', () => ({
  useToast: vi.fn(() => ({
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  })),
}));

vi.mock('@/lib/dashboard', async () => {
  const actual = await vi.importActual<typeof import('@/lib/dashboard')>('@/lib/dashboard');

  return {
    ...actual,
    disconnectUserAccount: vi.fn(),
    listUserAccounts: vi.fn(),
    listUserProviders: vi.fn(),
    startUserVerify: vi.fn(),
  };
});

import * as dashboardApi from '@/lib/dashboard';
import { Route as AccountConnectionsRoute } from '@/routes/account/connections';

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
        id: 'buyer-link-vrchat-1',
        provider: 'vrchat',
        label: 'VRChat account',
        connectionType: 'verification',
        status: 'active',
        webhookConfigured: false,
        hasApiKey: false,
        hasAccessToken: false,
        providerUserId: 'usr_vrchat_1',
        providerUsername: 'vrchat-user',
        verificationMethod: 'account_link',
        linkedAt: 1,
        lastValidatedAt: 2,
        expiresAt: null,
        createdAt: 1,
        updatedAt: 2,
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

    const gumroadCard = (await screen.findByText('Gumroad')).closest('.acct-provider-card');
    if (!(gumroadCard instanceof HTMLElement)) {
      throw new Error('Gumroad card was not rendered');
    }
    expect(within(gumroadCard).getByRole('button', { name: 'Connect' })).toBeInTheDocument();

    const vrchatHandle = await screen.findByText('vrchat-user');
    const vrchatCard = vrchatHandle.closest('.acct-provider-card');
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
});
