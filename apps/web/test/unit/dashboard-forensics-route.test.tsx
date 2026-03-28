import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentPropsWithoutRef, PropsWithChildren, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
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
  createFileRoute: () => (options: unknown) => ({ options }),
}));

vi.mock('@/components/ui/Select', () => ({
  Select: ({
    id,
    value,
    options,
    onChange,
    disabled,
  }: {
    id: string;
    value: string;
    options: Array<{ value: string; label: string }>;
    onChange: (value: string) => void;
    disabled?: boolean;
  }) => (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
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
  listCreatorCertificates: vi.fn(),
}));

vi.mock('@/lib/couplingForensics', () => ({
  isCouplingTraceabilityRequiredError: vi.fn(() => false),
  listCouplingForensicsPackages: vi.fn(),
  runCouplingForensicsLookup: vi.fn(),
}));

import * as certificateApi from '@/lib/certificates';
import * as forensicsApi from '@/lib/couplingForensics';
import { Route as ForensicsRoute } from '@/routes/_authenticated/dashboard/forensics';

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

function createCertificatesOverview(enabled: boolean) {
  return {
    workspaceKey: 'creator-profile:profile-1',
    creatorProfileId: 'profile-1',
    billing: {
      billingEnabled: true,
      status: enabled ? 'active' : 'inactive',
      allowEnrollment: enabled,
      allowSigning: enabled,
      planKey: enabled ? 'pro' : null,
      productId: enabled ? 'prod_pro' : null,
      deviceCap: enabled ? 5 : null,
      activeDeviceCount: 0,
      signQuotaPerPeriod: null,
      auditRetentionDays: enabled ? 90 : null,
      supportTier: enabled ? 'premium' : null,
      currentPeriodEnd: null,
      graceUntil: null,
      reason: enabled ? null : 'Certificate subscription required',
      capabilities: enabled
        ? [
            {
              capabilityKey: BILLING_CAPABILITY_KEYS.couplingTraceability,
              status: 'active',
            },
          ]
        : [],
    },
    devices: [],
    availablePlans: [],
    meters: [],
  };
}

describe('dashboard forensics route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(forensicsApi.listCouplingForensicsPackages).mockResolvedValue({
      packages: ['pkg.creator.bundle'],
    });
  });

  it('shows a retry UI instead of the upgrade gate when the entitlement query fails', async () => {
    vi.mocked(certificateApi.listCreatorCertificates).mockRejectedValue(
      new ApiError(400, { error: 'certificate lookup failed' })
    );

    const Component = ForensicsRoute.options.component;
    if (!Component) {
      throw new Error('Forensics route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument());

    expect(screen.queryByText('Creator Studio+ required')).not.toBeInTheDocument();
    expect(forensicsApi.listCouplingForensicsPackages).not.toHaveBeenCalled();
  });

  it('keeps the selected file immutable while a scan is pending', async () => {
    let resolveLookup: ((value: unknown) => void) | null = null;

    vi.mocked(certificateApi.listCreatorCertificates).mockResolvedValue(
      createCertificatesOverview(true)
    );
    vi.mocked(forensicsApi.runCouplingForensicsLookup).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        })
    );

    const Component = ForensicsRoute.options.component;
    if (!Component) {
      throw new Error('Forensics route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(document.getElementById('forensics-file')).toBeInstanceOf(HTMLInputElement)
    );
    const fileInput = document.getElementById('forensics-file');
    if (!(fileInput instanceof HTMLInputElement)) {
      throw new Error('Forensics file input was not rendered');
    }

    const originalFile = new File(['original'], 'original.zip', { type: 'application/zip' });
    fireEvent.change(fileInput, { target: { files: [originalFile] } });

    await waitFor(() => expect(screen.getByText('original.zip')).toBeInTheDocument());
    const submitButton = screen.getByRole('button', { name: /scan upload/i });
    await waitFor(() => expect(submitButton).not.toBeDisabled());

    fireEvent.click(submitButton);

    await waitFor(() => expect(forensicsApi.runCouplingForensicsLookup).toHaveBeenCalledTimes(1));

    const clearButton = screen.getByRole('button', { name: /remove file/i });
    const selectedInput = document.getElementById('forensics-file');
    if (!(selectedInput instanceof HTMLInputElement)) {
      throw new Error('Selected-state forensics file input was not rendered');
    }

    await waitFor(() => expect(selectedInput).toBeDisabled());

    fireEvent.click(clearButton);
    expect(screen.getByText('original.zip')).toBeInTheDocument();

    const replacementFile = new File(['replacement'], 'replacement.zip', {
      type: 'application/zip',
    });
    fireEvent.change(selectedInput, { target: { files: [replacementFile] } });

    expect(screen.getByText('original.zip')).toBeInTheDocument();
    expect(screen.queryByText('replacement.zip')).not.toBeInTheDocument();

    resolveLookup?.({
      packageId: 'pkg.creator.bundle',
      lookupStatus: 'no_candidate_assets',
      message: 'No authorized match found.',
      candidateAssetCount: 0,
      decodedAssetCount: 0,
      results: [],
    });
  });
});
