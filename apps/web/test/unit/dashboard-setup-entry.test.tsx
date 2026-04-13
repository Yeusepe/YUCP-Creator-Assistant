import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  createLazyFileRoute: () => (options: unknown) => ({ options }),
}));

vi.mock('convex/react', () => ({
  useMutation: vi.fn(() => vi.fn(() => Promise.resolve())),
  useQuery: vi.fn(() => []),
}));

vi.mock('@/hooks/useActiveDashboardContext', () => ({
  useActiveDashboardContext: vi.fn(() => ({
    activeGuildId: 'guild-123',
    activeTenantId: 'tenant-123',
    isPersonalDashboard: false,
  })),
}));

vi.mock('@/hooks/useDashboardSession', () => ({
  useDashboardSession: vi.fn(() => ({
    canRunPanelQueries: true,
    hasHydrated: true,
    markSessionExpired: vi.fn(),
    status: 'active',
  })),
}));

vi.mock('@/hooks/useDashboardShell', () => ({
  useDashboardShell: vi.fn(() => ({
    guilds: [],
    home: {
      providers: [],
      userAccounts: [],
    },
    viewer: {
      authUserId: 'tenant-123',
    },
  })),
}));

vi.mock('@/components/ui/Toast', () => ({
  useToast: vi.fn(() => ({
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  })),
}));

vi.mock('@/components/dashboard/panels/StoreIntegrationsPanel', () => ({
  StoreIntegrationsPanel: () => <div>store integrations</div>,
}));

vi.mock('@/components/dashboard/panels/ServerSettingsPanel', () => ({
  ServerSettingsPanel: () => <div>server settings</div>,
}));

vi.mock('@/components/dashboard/panels/RecentActivityPanel', () => ({
  RecentActivityPanel: () => <div>recent activity</div>,
}));

vi.mock('@/components/dashboard/panels/DangerZonePanel', () => ({
  DangerZonePanel: () => <div>danger zone</div>,
}));

vi.mock('@/components/dashboard/panels/SetupJourneyCard', () => ({
  SetupJourneyCard: () => <div data-testid="setup-journey-card">setup journey</div>,
}));

vi.mock('@/components/dashboard/panels/AutomaticSetupPanel', () => ({
  AutomaticSetupPanel: () => <div data-testid="automatic-setup-panel">automatic setup</div>,
}));

import { Route as DashboardIndexRoute } from '@/routes/_authenticated/dashboard/index.lazy';

describe('dashboard setup entry', () => {
  it('shows the dedicated setup entry card instead of rendering the full setup panel inline', () => {
    const Component = DashboardIndexRoute.options.component;
    if (!Component) {
      throw new Error('Dashboard index route component is not defined');
    }

    render(<Component />);

    expect(screen.getByTestId('setup-journey-card')).toBeInTheDocument();
    expect(screen.queryByTestId('automatic-setup-panel')).toBeNull();
  });
});
