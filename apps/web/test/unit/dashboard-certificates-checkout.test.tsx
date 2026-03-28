import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentPropsWithoutRef, PropsWithChildren, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockLinkProps = ComponentPropsWithoutRef<'a'> & {
  children?: ReactNode;
  search?: unknown;
  to?: unknown;
};

const { createEmbedCheckoutMock, searchState } = vi.hoisted(() => ({
  createEmbedCheckoutMock: vi.fn(),
  searchState: {} as Record<string, string | undefined>,
}));

vi.mock('@tanstack/react-router', () => {
  return {
    Link: ({ children, search: _search, to: _to, ...props }: MockLinkProps) => (
      <a {...props}>{children}</a>
    ),
    createFileRoute: () => (options: unknown) => {
      const route = {
        options,
        useSearch: vi.fn(() => searchState),
      };
      return route;
    },
  };
});

vi.mock('@polar-sh/checkout/embed', () => ({
  PolarEmbedCheckout: {
    create: createEmbedCheckoutMock,
  },
}));

vi.mock('@/components/ui/Toast', () => ({
  useToast: vi.fn(() => ({
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  })),
}));

vi.mock('@/hooks/useActiveDashboardContext', () => ({
  useActiveDashboardContext: vi.fn(() => ({
    activeGuildId: undefined,
    activeTenantId: 'creator-auth-user',
    isPersonalDashboard: true,
    selectedGuild: undefined,
    viewer: { authUserId: 'creator-auth-user' },
  })),
}));

vi.mock('@/hooks/useDashboardSession', () => ({
  isDashboardAuthError: vi.fn(() => false),
  useDashboardSession: vi.fn(() => ({
    canRunPanelQueries: true,
    isAuthResolved: true,
    markSessionExpired: vi.fn(),
    status: 'active',
  })),
}));

vi.mock('@/lib/certificates', () => ({
  createCreatorCertificateCheckout: vi.fn(),
  formatCertificateDate: vi.fn((value: number | null) => (value ? String(value) : 'Unknown date')),
  getCreatorCertificatePortal: vi.fn(),
  listCreatorCertificates: vi.fn(),
  reconcileCreatorCertificateBilling: vi.fn(),
  revokeCreatorCertificate: vi.fn(),
}));

import * as certificateApi from '@/lib/certificates';
import DashboardBilling from '@/routes/_authenticated/dashboard/billing';
import DashboardCertificates from '@/routes/_authenticated/dashboard/certificates';

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

function createMockCheckout() {
  const listeners = new Map<string, Array<() => void>>();

  return {
    addEventListener: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    close: vi.fn(() => {
      for (const listener of listeners.get('close') ?? []) {
        listener();
      }
    }),
    emit(event: string) {
      for (const listener of listeners.get(event) ?? []) {
        listener();
      }
    },
  };
}

describe('dashboard billing and certificates routes', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    for (const key of Object.keys(searchState)) {
      delete searchState[key];
    }

    vi.mocked(certificateApi.listCreatorCertificates).mockResolvedValue({
      workspaceKey: 'creator-profile:profile-1',
      creatorProfileId: 'profile-1',
      billing: {
        billingEnabled: true,
        status: 'inactive',
        allowEnrollment: false,
        allowSigning: false,
        planKey: null,
        productId: null,
        deviceCap: null,
        activeDeviceCount: 0,
        signQuotaPerPeriod: null,
        auditRetentionDays: null,
        supportTier: null,
        currentPeriodEnd: null,
        graceUntil: null,
        reason: 'Certificate subscription required',
        capabilities: [],
      },
      devices: [],
      availablePlans: [
        {
          planKey: 'starter',
          slug: 'starter',
          productId: 'prod_starter',
          displayName: 'Starter',
          description: 'Entry tier',
          highlights: ['Up to 2 signing devices'],
          priority: 1,
          displayBadge: undefined,
          deviceCap: 2,
          signQuotaPerPeriod: null,
          auditRetentionDays: 30,
          supportTier: 'standard',
          billingGraceDays: 3,
          capabilities: ['protected_exports'],
          meteredPrices: [],
        },
        {
          planKey: 'pro',
          slug: 'pro',
          productId: 'prod_pro',
          displayName: 'Pro',
          description: 'Expanded tier',
          highlights: ['Up to 5 signing devices'],
          priority: 2,
          displayBadge: 'Popular',
          deviceCap: 5,
          signQuotaPerPeriod: null,
          auditRetentionDays: 90,
          supportTier: 'premium',
          billingGraceDays: 3,
          capabilities: ['protected_exports', 'coupling_traceability'],
          meteredPrices: [],
        },
      ],
      meters: [],
    });
    vi.mocked(certificateApi.createCreatorCertificateCheckout).mockResolvedValue({
      url: 'https://polar.example.test/checkout',
      redirect: false,
      workspaceKey: 'creator-profile:profile-1',
      planKey: 'starter',
      productId: 'prod_starter',
    });
    vi.mocked(certificateApi.getCreatorCertificatePortal).mockResolvedValue({
      url: 'https://polar.example.test/portal',
      redirect: false,
    });
    vi.mocked(certificateApi.reconcileCreatorCertificateBilling).mockResolvedValue({
      reconciled: true,
      overview: {
        workspaceKey: 'creator-profile:profile-1',
        creatorProfileId: 'profile-1',
        billing: {
          billingEnabled: true,
          status: 'active',
          allowEnrollment: true,
          allowSigning: true,
          planKey: 'starter',
          productId: 'prod_starter',
          deviceCap: 2,
          activeDeviceCount: 0,
          signQuotaPerPeriod: null,
          auditRetentionDays: 30,
          supportTier: 'standard',
          currentPeriodEnd: null,
          graceUntil: null,
          reason: null,
          capabilities: [],
        },
        devices: [],
        availablePlans: [],
        meters: [],
      },
    });
    vi.mocked(certificateApi.revokeCreatorCertificate).mockResolvedValue({ success: true });
  });

  it('disables all plan actions while any embed checkout is active', async () => {
    const checkout = createMockCheckout();
    createEmbedCheckoutMock.mockResolvedValue(checkout);

    render(<DashboardBilling />, { wrapper: createWrapper() });

    const starterCard = (await screen.findByText('Starter')).closest('article');
    const proCard = (await screen.findByText('Pro')).closest('article');
    if (!(starterCard instanceof HTMLElement) || !(proCard instanceof HTMLElement)) {
      throw new Error('Plan cards were not rendered');
    }

    const starterButton = within(starterCard).getByRole('button', { name: /subscribe via polar/i });
    const proButton = within(proCard).getByRole('button', { name: /subscribe via polar/i });

    fireEvent.click(starterButton);

    await waitFor(() =>
      expect(certificateApi.createCreatorCertificateCheckout).toHaveBeenCalledWith({
        productId: 'prod_starter',
        planKey: 'starter',
      })
    );
    await waitFor(() => {
      expect(starterButton).toBeDisabled();
      expect(proButton).toBeDisabled();
    });

    fireEvent.click(proButton);
    expect(certificateApi.createCreatorCertificateCheckout).toHaveBeenCalledTimes(1);

    checkout.emit('close');

    await waitFor(() => {
      expect(starterButton).not.toBeDisabled();
      expect(proButton).not.toBeDisabled();
    });
  });

  it('keeps billing purchase actions off the certificates route', async () => {
    render(<DashboardCertificates />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('Code Signing Certificates')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /subscribe via polar/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Choose a Plan')).not.toBeInTheDocument();
    expect(screen.queryByText('Available Plans')).not.toBeInTheDocument();
  });
});
