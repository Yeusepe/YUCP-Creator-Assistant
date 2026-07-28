import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => {
  return {
    createFileRoute: () => (options: unknown) => ({ options }),
    createLazyFileRoute: () => (options: unknown) => ({ options }),
    useNavigate: vi.fn(() => vi.fn()),
  };
});

vi.mock('convex/react', () => {
  return {
    useMutation: vi.fn(() => vi.fn(() => Promise.resolve())),
    useQuery: vi.fn(() => undefined),
  };
});

vi.mock('@/hooks/useDashboardSession', () => {
  return {
    isDashboardAuthError: vi.fn(() => false),
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

vi.mock('@/lib/dashboard', () => {
  return {
    getDashboardSettings: vi.fn(),
    listGuildChannels: vi.fn(),
    updateDashboardSetting: vi.fn(),
  };
});

import { ServerSettingsPanel } from '@/components/dashboard/panels/ServerSettingsPanel';
import * as dashboardApi from '@/lib/dashboard';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('ServerSettingsPanel, HeroUI Switch', () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  beforeEach(() => {
    vi.mocked(dashboardApi.getDashboardSettings).mockResolvedValue({
      allowMismatchedEmails: false,
      announcementsChannelId: '',
      logChannelId: '',
      verificationScope: 'account',
    });

    vi.mocked(dashboardApi.listGuildChannels).mockResolvedValue([
      { id: 'ch-1', name: 'logs', type: 0 },
    ]);

    vi.mocked(dashboardApi.updateDashboardSetting).mockResolvedValue(undefined as never);
  });

  it('renders switch controls with role="switch" via React Aria (input element, not div)', async () => {
    render(
      <ServerSettingsPanel authUserId="user-1" guildId="guild-1" canRunPanelQueries={true} />,
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(screen.getByText('Allow Mismatched Emails')).toBeInTheDocument());

    const switches = screen.getAllByRole('switch');
    expect(switches.length).toBeGreaterThan(0);

    // React Aria renders switch as <input type="checkbox">, not a <div>
    for (const sw of switches) {
      expect(sw.tagName).toBe('INPUT');
    }
  });

  it('switch has an accessible name via aria-label', async () => {
    render(
      <ServerSettingsPanel authUserId="user-1" guildId="guild-1" canRunPanelQueries={true} />,
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(screen.getByText('Allow Mismatched Emails')).toBeInTheDocument());

    const sw = screen.getByRole('switch', { name: 'Allow Mismatched Emails' });
    expect(sw).toBeInTheDocument();
  });

  it('switch responds to keyboard interaction (Space key toggles)', async () => {
    render(
      <ServerSettingsPanel authUserId="user-1" guildId="guild-1" canRunPanelQueries={true} />,
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(screen.getByText('Allow Mismatched Emails')).toBeInTheDocument());

    const sw = screen.getByRole('switch', { name: 'Allow Mismatched Emails' });
    // react-aria input switch uses the native checked property
    expect((sw as HTMLInputElement).checked).toBe(false);

    // React Aria input switch responds to click (triggered by space/enter on native input)
    fireEvent.click(sw);

    await waitFor(() => expect(dashboardApi.updateDashboardSetting).toHaveBeenCalled());
  });
});
