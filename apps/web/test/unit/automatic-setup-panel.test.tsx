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

import { useQuery } from 'convex/react';
import { AutomaticSetupPanel } from '@/components/dashboard/panels/AutomaticSetupPanel';

describe('AutomaticSetupPanel', () => {
  beforeEach(() => {
    toastSuccessSpy.mockReset();
    toastErrorSpy.mockReset();
  });

  it('defaults to plain-language setup details without migration tools', () => {
    const mockedUseQuery = useQuery as unknown as ReturnType<typeof vi.fn>;
    mockedUseQuery.mockReturnValue(null);

    render(<AutomaticSetupPanel guildId="guild-123" />);

    expect(screen.getByText('Setup details')).toBeInTheDocument();
    expect(screen.getByText('Start setup')).toBeInTheDocument();
    expect(screen.queryByText('Provider connection modes')).toBeNull();
    expect(screen.queryByText('Migration tools')).toBeNull();
  });

  it('reveals migration tools only when explicitly requested', () => {
    const mockedUseQuery = useQuery as unknown as ReturnType<typeof vi.fn>;
    mockedUseQuery.mockReturnValue(null);

    render(<AutomaticSetupPanel guildId="guild-123" showMigrationCenter />);

    expect(screen.getByText('Migration tools')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Adopt Existing Roles' })).toBeInTheDocument();
  });
});
