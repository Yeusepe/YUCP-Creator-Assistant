import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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
    useActiveDashboardContext: vi.fn(() => ({
      activeGuildId: undefined,
      activeTenantId: undefined,
      isPersonalDashboard: true,
      selectedGuild: undefined,
      viewer: undefined,
    })),
  };
});

vi.mock('@/hooks/useDashboardSession', () => {
  return {
    useDashboardSession: vi.fn(() => ({
      canRunPanelQueries: false,
      clearSessionExpired: vi.fn(),
      hasHydrated: true,
      isAuthenticated: false,
      isAuthResolved: true,
      isSessionExpired: true,
      markSessionExpired: vi.fn(),
      status: 'expired',
    })),
  };
});

vi.mock('@/hooks/useDashboardShell', () => {
  return {
    useDashboardShell: vi.fn(() => ({
      guilds: [],
      selectedGuild: undefined,
      viewer: undefined,
    })),
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

import { Route as DashboardIndexRoute } from '@/routes/_authenticated/dashboard/index.lazy';

describe('dashboard index auth guard', () => {
  it('renders the auth-required state without crashing when viewer auth is unavailable', () => {
    const Component = DashboardIndexRoute.options.component;
    if (!Component) {
      throw new Error('Dashboard index route component is not defined');
    }

    render(<Component />);

    expect(screen.getByText(/sign in to view your dashboard/i)).toBeInTheDocument();
  });
});
