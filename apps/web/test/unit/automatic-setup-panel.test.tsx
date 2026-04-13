import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toastSuccessSpy = vi.fn();
const toastErrorSpy = vi.fn();

vi.mock('convex/react', () => ({
  useMutation: vi.fn(() => vi.fn()),
  useQuery: vi.fn(),
}));

vi.mock('@/components/dashboard/DashboardSkeletonSwap', () => ({
  DashboardSkeletonSwap: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/dashboard/DashboardSkeletons', () => ({
  DashboardListSkeleton: () => <div>Loading</div>,
}));

vi.mock('@/components/ui/Toast', () => ({
  useToast: vi.fn(() => ({
    error: toastErrorSpy,
    success: toastSuccessSpy,
  })),
}));

vi.mock('@/components/ui/YucpButton', () => ({
  YucpButton: ({
    children,
    onPress,
    isLoading,
  }: {
    children: ReactNode;
    onPress?: () => void | Promise<void>;
    isLoading?: boolean;
  }) => (
    <button disabled={isLoading} onClick={() => void onPress?.()} type="button">
      {children}
    </button>
  ),
}));

vi.mock('@/hooks/useDashboardShell', () => ({
  useDashboardShell: vi.fn(),
}));

import { useQuery } from 'convex/react';
import { AutomaticSetupPanel } from '@/components/dashboard/panels/AutomaticSetupPanel';
import { useDashboardShell } from '@/hooks/useDashboardShell';

describe('AutomaticSetupPanel', () => {
  beforeEach(() => {
    toastSuccessSpy.mockReset();
    toastErrorSpy.mockReset();

    vi.mocked(useDashboardShell).mockReturnValue({
      guilds: [],
      home: {
        connectionStatusAuthUserId: 'tenant-123',
        connectionStatusByProvider: {},
        providers: [
          {
            connectParamStyle: 'camelCase',
            connectPath: '/api/connect/gumroad/begin',
            icon: 'Gumorad.png',
            iconBg: '#0f0f12',
            key: 'gumroad',
            label: 'Gumroad',
            quickStartBg: 'rgba(255,255,255,0.05)',
            quickStartBorder: 'rgba(255,255,255,0.1)',
            serverTileHint: 'Allow users to verify Gumroad purchases in this Discord server.',
            setupExperience: 'automatic',
            setupHint: 'OAuth redirect plus managed webhook setup can continue automatically.',
          },
          {
            connectParamStyle: 'snakeCase',
            connectPath: '/setup/vrchat?mode=connect',
            icon: 'VRC.png',
            iconBg: '#00b48c',
            key: 'vrchat',
            label: 'VRChat',
            quickStartBg: 'rgba(0,180,140,0.1)',
            quickStartBorder: 'rgba(0,180,140,0.3)',
            serverTileHint: 'Allow users to verify VRChat avatar access in this Discord server.',
            setupExperience: 'guided',
            setupHint:
              'VRChat needs a credential handoff before the setup job can scan listings and resume.',
          },
        ],
        userAccounts: [],
      },
      selectedGuild: undefined,
      viewer: {
        authUserId: 'tenant-123',
      },
    });
  });

  it('renders provider connection modes from dashboard provider metadata', () => {
    vi.mocked(useQuery).mockReturnValue(null);

    render(<AutomaticSetupPanel guildId="guild-123" />);

    expect(screen.getByText('Provider connection modes')).toBeInTheDocument();
    expect(
      screen.getByText('OAuth redirect plus managed webhook setup can continue automatically.')
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'VRChat needs a credential handoff before the setup job can scan listings and resume.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText('Automatic')).toBeInTheDocument();
    expect(screen.getByText('Guided')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start Automatic Setup' })).toBeInTheDocument();
  });
});
