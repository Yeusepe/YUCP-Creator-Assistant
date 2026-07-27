import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentPropsWithoutRef, PropsWithChildren, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BILLING_CAPABILITY_KEYS } from '../../../../convex/lib/billingCapabilities';

type MockLinkProps = ComponentPropsWithoutRef<'a'> & {
  children?: ReactNode;
  search?: unknown;
  to?: unknown;
};

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, search: _search, to: _to, ...props }: MockLinkProps) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
}));

vi.mock('@/hooks/useActiveDashboardContext', () => ({
  useActiveDashboardContext: () => ({
    activeGuildId: undefined,
    activeTenantId: 'creator-auth-user',
    isPersonalDashboard: true,
    selectedGuild: undefined,
    viewer: { authUserId: 'creator-auth-user' },
  }),
}));

vi.mock('@/hooks/useDashboardSession', () => ({
  isDashboardAuthError: () => false,
  useDashboardSession: () => ({
    canRunPanelQueries: true,
    isAuthResolved: true,
    markSessionExpired: vi.fn(),
    status: 'active',
  }),
}));

vi.mock('@/lib/certificates', () => ({
  hasActiveCreatorBillingCapability: (
    capabilities: Array<{ capabilityKey: string; status: string }> | undefined,
    capabilityKey: string
  ) =>
    capabilities?.some(
      (capability) =>
        capability.capabilityKey === capabilityKey &&
        (capability.status === 'active' || capability.status === 'grace')
    ) ?? false,
  listCreatorCertificates: vi.fn(),
}));

vi.mock('@/lib/couplingForensics', () => ({
  isCouplingTraceabilityRequiredError: () => false,
  listCouplingForensicsPackages: vi.fn(),
  runCouplingForensicsLookup: vi.fn(),
}));

import { CouplingForensicsPanel } from '@/components/dashboard/CouplingForensicsPanel';
import * as certificateApi from '@/lib/certificates';
import * as forensicsApi from '@/lib/couplingForensics';

const listCreatorCertificatesMock = certificateApi.listCreatorCertificates as ReturnType<
  typeof vi.fn
>;
const listCouplingForensicsPackagesMock = forensicsApi.listCouplingForensicsPackages as ReturnType<
  typeof vi.fn
>;

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

describe('dashboard forensics product picker accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listCreatorCertificatesMock.mockResolvedValue({
      workspaceKey: 'creator-profile:profile-1',
      creatorProfileId: 'profile-1',
      billing: {
        billingEnabled: true,
        status: 'active',
        allowEnrollment: true,
        allowSigning: true,
        planKey: 'pro',
        productId: 'prod_pro',
        deviceCap: 5,
        activeDeviceCount: 0,
        signQuotaPerPeriod: null,
        auditRetentionDays: 90,
        supportTier: 'premium',
        currentPeriodEnd: null,
        graceUntil: null,
        reason: null,
        capabilities: [
          {
            capabilityKey: BILLING_CAPABILITY_KEYS.couplingTraceability,
            status: 'active',
          },
        ],
      },
      devices: [],
      availablePlans: [],
      meters: [],
    });
    listCouplingForensicsPackagesMock.mockResolvedValue({
      packages: [
        {
          packageId: 'pkg.creator.bundle',
          packageName: 'Creator Bundle',
          registeredAt: 1,
          updatedAt: 2,
        },
      ],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('labels the product picker and its dialog without accessibility warnings', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      render(<CouplingForensicsPanel />, { wrapper: createWrapper() });

      expect(await screen.findByText('Which product is this file from?')).toBeInTheDocument();
      await waitFor(() => {
        const trigger = document.querySelector(
          '[data-slot="autocomplete-trigger"] button[aria-haspopup="listbox"]'
        );
        expect(trigger).toBeInstanceOf(HTMLButtonElement);
        expect(trigger).not.toBeDisabled();
      });
      const pickerTrigger = document.querySelector(
        '[data-slot="autocomplete-trigger"] button[aria-haspopup="listbox"]'
      );
      expect(pickerTrigger).toBeInstanceOf(HTMLButtonElement);
      fireEvent.click(pickerTrigger as HTMLButtonElement);
      expect(
        await screen.findByRole('option', {
          name: 'Creator Bundle',
        })
      ).toBeInTheDocument();

      expect(pickerTrigger).toHaveAccessibleName(/Product to scan/i);
      expect(screen.getByText('Product to scan', { selector: '[data-slot="label"]' })).toHaveClass(
        'sr-only'
      );
      expect(screen.getByText('Search products', { selector: '[data-slot="label"]' })).toHaveClass(
        'sr-only'
      );
      expect(screen.getByRole('listbox', { name: /Products available to scan/i })).toBeVisible();
      expect(screen.getByRole('heading', { name: 'Choose a product to scan' })).toHaveClass(
        'sr-only'
      );
      expect(document.querySelector('[data-slot="autocomplete-popover-dialog"]')).toHaveAttribute(
        'aria-label',
        'Choose a product to scan'
      );
      expect(
        document.querySelector('[data-slot="autocomplete-popover-dialog"]')
      ).toHaveAccessibleName('Choose a product to scan');
      const consoleOutput = [...warnSpy.mock.calls, ...errorSpy.mock.calls]
        .flat()
        .map(String)
        .join(' ');
      expect(consoleOutput).not.toMatch(/If you do not provide a visible label/i);
      expect(consoleOutput).not.toMatch(/If a Dialog does not contain a <Heading slot="title">/i);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
