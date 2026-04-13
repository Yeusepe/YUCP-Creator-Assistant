import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useQueryMock = vi.fn();
const useMutationMock = vi.fn(() => vi.fn());

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    search: _search,
    ...props
  }: {
    children: ReactNode;
    to?: string;
    [key: string]: unknown;
  }) => (
    <a href={typeof to === 'string' ? to : '#'} {...props}>
      {children}
    </a>
  ),
  createLazyFileRoute: () => (options: unknown) => ({ options }),
}));

vi.mock('convex/react', () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
  useMutation: (...args: unknown[]) => useMutationMock(...args),
}));

vi.mock('../../../../../../convex/_generated/api', () => ({
  api: {
    setupJobs: {
      getMySetupJobForGuild: 'getMySetupJobForGuild',
      getMySetupSummaryByGuild: 'getMySetupSummaryByGuild',
      createOrResumeSetupJobByGuild: 'createOrResumeSetupJobByGuild',
      applyRecommendedSetupByGuild: 'applyRecommendedSetupByGuild',
    },
  },
}));

vi.mock('@/components/dashboard/AuthRequiredState', () => ({
  DashboardAuthRequiredState: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/components/ui/YucpButton', () => ({
  YucpButton: ({
    children,
    onPress,
    isLoading,
  }: {
    children: ReactNode;
    onPress?: () => void;
    isLoading?: boolean;
  }) => (
    <button type="button" onClick={onPress} aria-busy={isLoading}>
      {children}
    </button>
  ),
}));

vi.mock('@/hooks/useActiveDashboardContext', () => ({
  useActiveDashboardContext: vi.fn(() => ({
    activeGuildId: 'guild-123',
    activeTenantId: 'tenant-123',
    isPersonalDashboard: false,
  })),
}));

vi.mock('@/hooks/useDashboardShell', () => ({
  useDashboardShell: vi.fn(() => ({
    home: {
      providers: [],
      userAccounts: [],
    },
    selectedGuild: {
      id: 'guild-123',
      name: 'Test Guild',
      tenantId: 'tenant-123',
    },
  })),
}));

vi.mock('@/hooks/useDashboardSession', () => ({
  useDashboardSession: vi.fn(() => ({
    hasHydrated: true,
    markSessionExpired: vi.fn(),
    status: 'active',
  })),
}));

import { Route as DashboardSetupRoute } from '@/routes/_authenticated/dashboard/setup.lazy';

describe('dashboard setup route', () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    useMutationMock.mockReset();
    useMutationMock.mockReturnValue(vi.fn());
  });

  it('shows a beginner-friendly start page for a new server', () => {
    useQueryMock.mockReturnValueOnce(null).mockReturnValueOnce({
      enabledRoleRuleCount: 0,
      verificationPromptLive: false,
      lastCompletedSetupAt: null,
    });

    const Component = DashboardSetupRoute.options.component;
    if (!Component) {
      throw new Error('Dashboard setup route component is not defined');
    }

    render(<Component />);

    expect(screen.getByText('Set up product verification for this server')).toBeInTheDocument();
    expect(screen.getByText(/Before you begin, make sure you have/)).toBeInTheDocument();
    expect(screen.getByText('Start setup')).toBeInTheDocument();
    expect(screen.getByText('Switching from another bot?')).toBeInTheDocument();
  });

  it('shows a focused wizard step for setup in progress', () => {
    useQueryMock
      .mockReturnValueOnce({
        job: {
          status: 'waiting_for_user',
          currentPhase: 'review_exceptions',
        },
        steps: [
          { id: 'step-1', label: 'Connect store', status: 'completed' },
          { id: 'step-2', label: 'Scan server', status: 'completed' },
        ],
        recommendations: [
          {
            id: 'rec-1',
            status: 'proposed',
            recommendationType: 'role_creation',
            title: 'Create subscriber role',
            detail: null,
          },
          {
            id: 'rec-2',
            status: 'proposed',
            recommendationType: 'verify_surface_creation',
            title: 'Create a dedicated verify surface',
            detail: null,
          },
        ],
        activeMigrationJobId: null,
      })
      .mockReturnValueOnce({
        enabledRoleRuleCount: 0,
        verificationPromptLive: false,
        lastCompletedSetupAt: null,
      });

    const Component = DashboardSetupRoute.options.component;
    if (!Component) {
      throw new Error('Dashboard setup route component is not defined');
    }

    render(<Component />);

    expect(screen.getByText('Review your setup plan')).toBeInTheDocument();
    expect(screen.getByText('Step 3 of 3')).toBeInTheDocument();
    expect(screen.getByText('Apply 2 changes')).toBeInTheDocument();
    expect(screen.getByText('What will happen when you click Apply')).toBeInTheDocument();
  });

  it('shows a maintenance view when the server is already configured', () => {
    useQueryMock.mockReturnValueOnce(null).mockReturnValueOnce({
      enabledRoleRuleCount: 4,
      verificationPromptLive: true,
      lastCompletedSetupAt: Date.UTC(2026, 3, 12),
    });

    const Component = DashboardSetupRoute.options.component;
    if (!Component) {
      throw new Error('Dashboard setup route component is not defined');
    }

    render(<Component />);

    expect(screen.getByText('This server is already set up')).toBeInTheDocument();
    expect(screen.getByText('Storefronts connected')).toBeInTheDocument();
    expect(screen.getByText('Product-role mappings')).toBeInTheDocument();
    expect(screen.getByText('Verification message')).toBeInTheDocument();
    expect(screen.getByText('Update setup')).toBeInTheDocument();
    expect(screen.getByText('Add another store')).toBeInTheDocument();
    expect(screen.getByText('Update role mappings')).toBeInTheDocument();
  });

  it('shows a needs-attention view with fix guidance when setup is blocked', () => {
    useQueryMock
      .mockReturnValueOnce({
        job: {
          status: 'blocked',
          currentPhase: 'scan_server',
          blockingReason: 'The bot does not have permission to manage roles.',
        },
        steps: [],
        recommendations: [],
        activeMigrationJobId: null,
      })
      .mockReturnValueOnce({
        enabledRoleRuleCount: 0,
        verificationPromptLive: false,
        lastCompletedSetupAt: null,
      });

    const Component = DashboardSetupRoute.options.component;
    if (!Component) {
      throw new Error('Dashboard setup route component is not defined');
    }

    render(<Component />);

    expect(screen.getByText('One thing needs your attention')).toBeInTheDocument();
    expect(
      screen.getByText('The bot does not have permission to manage roles.')
    ).toBeInTheDocument();
    expect(screen.getByText('How to fix it')).toBeInTheDocument();
    expect(screen.getByText('Try again')).toBeInTheDocument();
  });
});
