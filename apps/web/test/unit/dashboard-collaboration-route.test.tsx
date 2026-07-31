import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  createLazyFileRoute: () => (options: unknown) => ({ options }),
}));

vi.mock('@/hooks/useDashboardShell', () => ({
  useDashboardShell: vi.fn(() => ({
    guilds: [],
    selectedGuild: undefined,
    viewer: {
      authUserId: 'user-123',
    },
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

vi.mock('@/lib/dashboard', async () => {
  const actual = await vi.importActual<typeof import('@/lib/dashboard')>('@/lib/dashboard');

  return {
    ...actual,
    createCollabInvite: vi.fn(),
    listCollabConnectionsAsCollaborator: vi.fn(),
    listCollabInvites: vi.fn(),
    listCollabProviders: vi.fn(),
    listCreatorWorkspaceMembers: vi.fn(),
    removeCollabConnectionAsCollaborator: vi.fn(),
    removeCreatorWorkspaceMember: vi.fn(),
    revokeCollabInvite: vi.fn(),
  };
});

vi.mock('@/lib/packages', () => ({
  listCreatorPackagePickerProducts: vi.fn(async () => []),
}));

import * as dashboardApi from '@/lib/dashboard';
import { Route as CollaborationRoute } from '@/routes/_authenticated/dashboard/collaboration.lazy';

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

function createPortalRoot() {
  const portalRoot = document.createElement('div');
  portalRoot.id = 'portal-root';
  document.body.appendChild(portalRoot);
}

describe('dashboard collaboration route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(dashboardApi.listCollabProviders).mockResolvedValue([]);
    vi.mocked(dashboardApi.listCollabInvites).mockResolvedValue([]);
    vi.mocked(dashboardApi.listCreatorWorkspaceMembers).mockResolvedValue([]);
    vi.mocked(dashboardApi.listCollabConnectionsAsCollaborator).mockResolvedValue([
      {
        id: 'conn-1',
        ownerAuthUserId: 'owner-1',
        ownerDisplayName: 'Creator Store',
        provider: 'jinxxy',
        linkType: 'account',
        createdAt: Date.now() - 60_000,
      },
    ]);
    vi.mocked(dashboardApi.removeCollabConnectionAsCollaborator).mockResolvedValue({
      success: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    document.body.innerHTML = '';
  });

  it('cancels store removal when the hold is released early', async () => {
    const Component = CollaborationRoute.options.component;
    if (!Component) {
      throw new Error('Collaboration route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('Creator Store')).toBeInTheDocument());

    vi.useFakeTimers();
    const button = screen.getByRole('button', { name: /hold to remove creator store/i });
    fireEvent.keyDown(button, { key: 'Enter' });
    await vi.advanceTimersByTimeAsync(400);
    fireEvent.keyUp(button, { key: 'Enter' });
    await vi.advanceTimersByTimeAsync(700);

    expect(dashboardApi.removeCollabConnectionAsCollaborator).not.toHaveBeenCalled();
  });

  it('removes loading placeholders after both collaboration sections resolve', async () => {
    const Component = CollaborationRoute.options.component;
    if (!Component) {
      throw new Error('Collaboration route component is not defined');
    }

    const { container } = render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('No collaborators yet.')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Creator Store')).toBeInTheDocument());

    expect(container.querySelector('.skeleton-action-row, .skeleton-stack')).toBeNull();
  });

  it('removes a collaborator store after holding the leave control', async () => {
    const Component = CollaborationRoute.options.component;
    if (!Component) {
      throw new Error('Collaboration route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('Creator Store')).toBeInTheDocument());

    vi.useFakeTimers();
    const button = screen.getByRole('button', { name: /hold to remove creator store/i });
    fireEvent.keyDown(button, { key: 'Enter' });
    await vi.advanceTimersByTimeAsync(1300);
    await Promise.resolve();

    expect(dashboardApi.removeCollabConnectionAsCollaborator).toHaveBeenCalledWith(
      'user-123',
      'conn-1'
    );
  });

  it('does not synthesize share links from pending invite ids', async () => {
    vi.mocked(dashboardApi.listCollabProviders).mockResolvedValue([
      { key: 'jinxxy', label: 'Jinxxy' },
    ]);
    vi.mocked(dashboardApi.listCollabInvites).mockResolvedValue([
      {
        id: 'invite-id-only',
        providerKey: 'jinxxy',
        ownerDisplayName: 'Creator Store',
        expiresAt: Date.now() + 86_400_000,
        createdAt: Date.now(),
      },
    ]);

    const Component = CollaborationRoute.options.component;
    if (!Component) {
      throw new Error('Collaboration route component is not defined');
    }

    createPortalRoot();

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('Pending Invites')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /^copy link$/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /invite a creator/i }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /generate invite link/i })).toBeInTheDocument()
    );
    expect(screen.queryByText(/\/collab-invite\?id=invite-id-only/)).not.toBeInTheDocument();
  });

  it('starts new invitations with no workspace access or store scope', async () => {
    vi.mocked(dashboardApi.listCollabProviders).mockResolvedValue([
      { key: 'jinxxy', label: 'Jinxxy' },
    ]);
    const Component = CollaborationRoute.options.component;
    if (!Component) {
      throw new Error('Collaboration route component is not defined');
    }
    createPortalRoot();
    render(<Component />, { wrapper: createWrapper() });

    fireEvent.click((await screen.findAllByRole('button', { name: /invite a creator/i }))[0]);
    expect(
      await screen.findByText('No access. Everything stays off until you grant it after they join.')
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Store Platform')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /generate invite link/i })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Configure access' })).not.toBeInTheDocument();
  });

  it('creates a provider-independent invitation with everything off by default', async () => {
    vi.mocked(dashboardApi.createCollabInvite).mockResolvedValue({
      inviteUrl: 'https://verify.example/collab-invite#t=workspace-token',
      expiresAt: Date.now() + 86_400_000,
    });
    const Component = CollaborationRoute.options.component;
    if (!Component) {
      throw new Error('Collaboration route component is not defined');
    }
    createPortalRoot();
    render(<Component />, { wrapper: createWrapper() });

    fireEvent.click((await screen.findAllByRole('button', { name: /invite a creator/i }))[0]);
    fireEvent.click(await screen.findByRole('button', { name: /generate invite link/i }));

    await waitFor(() =>
      expect(dashboardApi.createCollabInvite).toHaveBeenCalledWith('user-123', {})
    );
  });
});
