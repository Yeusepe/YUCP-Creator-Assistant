import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  createLazyFileRoute: () => (options: unknown) => ({ options }),
}));

vi.mock('@/components/ui/Toast', () => ({
  useToast: vi.fn(() => ({
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  })),
}));

vi.mock('@/lib/account', () => ({
  formatAccountDate: vi.fn((value: number | null) => (value ? 'Apr 13, 2026' : 'Unknown date')),
  getAccountProviderIconPath: vi.fn(() => null),
  listUserLicenses: vi.fn(),
  revokeUserLicense: vi.fn(),
  listUserOAuthGrants: vi.fn(),
  revokeUserOAuthGrant: vi.fn(),
}));

import * as accountApi from '@/lib/account';
import { Route as AccountAuthorizedAppsRoute } from '../../src/routes/_authenticated/account/authorized-apps.lazy';
import { Route as AccountLicensesRoute } from '../../src/routes/_authenticated/account/licenses.lazy';

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

describe('account tooltip routes', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('renders the licenses route with provider reference tooltips', async () => {
    vi.mocked(accountApi.listUserLicenses).mockResolvedValue([
      {
        id: 'subject-1',
        displayName: 'Buyer Account',
        status: 'active',
        entitlements: [
          {
            id: 'ent-1',
            sourceProvider: 'gumroad',
            productId: 'prod_123',
            sourceReference: 'reference_1234567890abcdef',
            status: 'active',
            grantedAt: 1712966400000,
            revokedAt: null,
          },
        ],
      },
    ]);

    const Component = AccountLicensesRoute.options.component;
    if (!Component) {
      throw new Error('Account licenses route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(accountApi.listUserLicenses).toHaveBeenCalled());
    expect(await screen.findByText('prod_123')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'reference_1234567890abcdef' })).toHaveLength(1);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('renders the authorized apps route with client id tooltips', async () => {
    vi.mocked(accountApi.listUserOAuthGrants).mockResolvedValue([
      {
        consentId: 'consent-1',
        clientId: 'client_1234567890abcdef',
        appName: 'Builder App',
        scopes: ['profile:read', 'licenses:read'],
        grantedAt: 1712966400000,
        updatedAt: 1712966400000,
      },
    ]);

    const Component = AccountAuthorizedAppsRoute.options.component;
    if (!Component) {
      throw new Error('Account authorized apps route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(accountApi.listUserOAuthGrants).toHaveBeenCalled());
    expect(await screen.findByText('Builder App')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'client_1234567890abcdef' })).toHaveLength(1);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
