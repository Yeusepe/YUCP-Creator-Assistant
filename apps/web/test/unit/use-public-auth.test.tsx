import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
}));

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    getSession: getSessionMock,
    signIn: {
      social: vi.fn(),
    },
    signOut: vi.fn(),
  },
}));

import { usePublicAuth } from '@/hooks/usePublicAuth';

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

function Probe() {
  const { isAuthenticated, isPending } = usePublicAuth();

  if (isPending) {
    return <div>pending</div>;
  }

  return <div>{isAuthenticated ? 'authenticated' : 'anonymous'}</div>;
}

describe('usePublicAuth', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('does not require a Convex auth provider to resolve an anonymous public session', async () => {
    getSessionMock.mockResolvedValue({ data: null });

    render(<Probe />, { wrapper: createWrapper() });

    expect(screen.getByText('pending')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('anonymous')).toBeInTheDocument());
  });

  it('reports an authenticated public session when Better Auth returns one', async () => {
    getSessionMock.mockResolvedValue({
      data: {
        session: { id: 'session_123' },
        user: { id: 'user_123' },
      },
    });

    render(<Probe />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('authenticated')).toBeInTheDocument());
  });
});
