import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const useSearchMock = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  createLazyFileRoute: () => (options: unknown) => ({ options }),
  useSearch: () => useSearchMock(),
}));

import { Route as VrchatSetupRoute } from '@/routes/setup/vrchat.lazy';

function getComponent() {
  const Component = VrchatSetupRoute.options.component;
  if (!Component) {
    throw new Error('VRChat setup route component is not defined');
  }
  return Component;
}

function enterCredentials() {
  fireEvent.change(screen.getByLabelText(/vrchat.*username/i), {
    target: { value: 'creator' },
  });
  fireEvent.change(screen.getByLabelText(/vrchat.*password/i), {
    target: { value: 'secret' },
  });
}

describe('VRChat setup behavior', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState({}, '', '/setup/vrchat');
    useSearchMock.mockReturnValue({
      token: '',
      mode: 'connect',
      guild_id: '',
      tenant_id: '',
      returnUrl: '',
    });
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('returns a connected creator to the dashboard with the selected server context', async () => {
    useSearchMock.mockReturnValue({
      token: '',
      mode: 'connect',
      guild_id: 'guild-123',
      tenant_id: 'tenant-123',
      returnUrl: '',
    });
    vi.mocked(window.fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const Component = getComponent();
    render(<Component />);
    enterCredentials();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(window.location.pathname).toBe('/dashboard'));
    expect(window.location.search).toContain('vrchat=connected');
    expect(window.location.search).toContain('guild_id=guild-123');
    expect(window.location.search).toContain('tenant_id=tenant-123');
  });

  it('shows and submits the credential form for dashboard connect mode without a setup token', async () => {
    vi.mocked(window.fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'Invalid credentials' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const Component = getComponent();
    render(<Component />);

    expect(screen.getByLabelText(/vrchat.*username/i)).toBeVisible();
    expect(screen.getByLabelText(/vrchat.*password/i)).toBeVisible();
    expect(window.fetch).not.toHaveBeenCalled();

    enterCredentials();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() =>
      expect(window.fetch).toHaveBeenCalledWith(
        '/api/connect/vrchat/session',
        expect.objectContaining({
          body: JSON.stringify({ username: 'creator', password: 'secret' }),
          credentials: 'include',
          method: 'POST',
        })
      )
    );
  });

  it('keeps recoverable session errors inline and returns the creator to the credential form', async () => {
    vi.mocked(window.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          sessionExpired: true,
          error: 'Your VRChat session expired. Sign in again.',
        }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const Component = getComponent();
    render(<Component />);
    enterCredentials();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Your VRChat session expired. Sign in again.')).toBeVisible();
    expect(screen.getByLabelText(/vrchat.*username/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });
});
