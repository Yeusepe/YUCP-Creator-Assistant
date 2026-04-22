import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => {
  return {
    createFileRoute: () => (options: unknown) => ({ options }),
    createLazyFileRoute: () => (options: unknown) => ({ options }),
  };
});

vi.mock('convex/react', () => {
  return {
    useMutation: vi.fn(() => vi.fn(() => Promise.resolve())),
    useQuery: vi.fn(() => []),
  };
});

vi.mock('@/hooks/useActiveDashboardContext', () => {
  return {
    useActiveDashboardContext: vi.fn(),
  };
});

vi.mock('@/hooks/useDashboardSession', () => {
  return {
    useDashboardSession: vi.fn(),
  };
});

vi.mock('@/hooks/useDashboardShell', () => {
  return {
    useDashboardShell: vi.fn(),
  };
});

vi.mock('@/components/ui/Toast', () => {
  return {
    useToast: vi.fn(() => ({
      error: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
    })),
  };
});

vi.mock('@/components/dashboard/panels/ConnectedPlatformsPanel', () => {
  return {
    ConnectedPlatformsPanel: () => <div data-testid="connected-platforms-panel" />,
  };
});

vi.mock('@/components/dashboard/panels/DangerZonePanel', () => {
  return {
    DangerZonePanel: () => <div data-testid="danger-zone-panel" />,
  };
});

vi.mock('@/components/dashboard/panels/OnboardingProgressPanel', () => {
  return {
    OnboardingProgressPanel: () => <div data-testid="onboarding-panel" />,
  };
});

vi.mock('@/components/dashboard/panels/ServerSettingsPanel', () => {
  return {
    ServerSettingsPanel: () => <div data-testid="server-settings-panel" />,
  };
});

vi.mock('@/components/dashboard/panels/StatsOverviewPanel', () => {
  return {
    StatsOverviewPanel: () => <div data-testid="stats-overview-panel" />,
  };
});

vi.mock('@/components/dashboard/panels/StoreIntegrationsPanel', () => {
  return {
    StoreIntegrationsPanel: () => <div data-testid="store-integrations-panel" />,
  };
});

import { useActiveDashboardContext } from '@/hooks/useActiveDashboardContext';
import { useDashboardSession } from '@/hooks/useDashboardSession';
import { useDashboardShell } from '@/hooks/useDashboardShell';
import { Route as DashboardIndexRoute } from '@/routes/_authenticated/dashboard/index.lazy';

describe('dashboard onboarding hydration', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();

    vi.mocked(useActiveDashboardContext).mockReturnValue({
      activeGuildId: undefined,
      activeTenantId: 'user-123',
      isPersonalDashboard: true,
      selectedGuild: undefined,
      viewer: {
        authUserId: 'user-123',
      },
    });

    vi.mocked(useDashboardSession).mockReturnValue({
      canRunPanelQueries: true,
      clearSessionExpired: vi.fn(),
      hasHydrated: true,
      isAuthenticated: true,
      isAuthResolved: true,
      isSessionExpired: false,
      markSessionExpired: vi.fn(),
      status: 'active',
    });

    vi.mocked(useDashboardShell).mockReturnValue({
      guilds: [],
      home: {
        connectionStatusAuthUserId: 'user-123',
        connectionStatusByProvider: {},
        providers: [],
        userAccounts: [],
      },
      selectedGuild: undefined,
      viewer: {
        authUserId: 'user-123',
      },
    });
  });

  function renderComponent() {
    const Component = DashboardIndexRoute.options.component;
    if (!Component) {
      throw new Error('Dashboard index route component is not defined');
    }

    render(<Component />);
  }

  it('does not render the onboarding panel before hydration completes', () => {
    vi.mocked(useDashboardSession).mockReturnValue({
      canRunPanelQueries: false,
      clearSessionExpired: vi.fn(),
      hasHydrated: false,
      isAuthenticated: true,
      isAuthResolved: false,
      isSessionExpired: false,
      markSessionExpired: vi.fn(),
      status: 'resolving',
    });

    renderComponent();

    expect(screen.queryByTestId('onboarding-panel')).not.toBeInTheDocument();
  });

  it('does not render the onboarding panel when the shell already shows onboarding is complete', () => {
    localStorage.setItem('yucp_onboarding_state:user-123', JSON.stringify({ docsRead: true }));

    vi.mocked(useDashboardShell).mockReturnValue({
      guilds: [
        {
          icon: null,
          id: 'guild-123',
          name: 'My Server',
          tenantId: 'user-123',
        },
      ],
      home: {
        connectionStatusAuthUserId: 'user-123',
        connectionStatusByProvider: {
          gumroad: true,
        },
        providers: [
          {
            key: 'discord',
          },
          {
            connectPath: '/connect/gumroad',
            key: 'gumroad',
          },
        ],
        userAccounts: [
          {
            authUserId: 'user-123',
            connectionType: 'setup',
            createdAt: 1,
            hasAccessToken: true,
            hasApiKey: false,
            id: 'account-123',
            label: 'Creator storefront',
            provider: 'gumroad',
            status: 'active',
            updatedAt: 1,
            webhookConfigured: true,
          },
        ],
      },
      selectedGuild: undefined,
      viewer: {
        authUserId: 'user-123',
      },
    });

    renderComponent();

    expect(screen.queryByTestId('onboarding-panel')).not.toBeInTheDocument();
  });
});
