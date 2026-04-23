import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  createLazyFileRoute: () => (options: unknown) => ({ options }),
}));

vi.mock('@/components/page/BackgroundCanvasRoot', () => ({
  BackgroundCanvasRoot: () => null,
}));

import { Route } from '@/routes/oauth/callback/itchio.lazy';

describe('itch.io OAuth callback route', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.restoreAllMocks();

    Object.defineProperty(window, 'fetch', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });

    Object.defineProperty(window.location, 'reload', {
      configurable: true,
      value: vi.fn(),
    });

    Object.defineProperty(window.location, 'replace', {
      configurable: true,
      value: vi.fn(),
    });

    window.history.replaceState({}, '', '/oauth/callback/itchio');
  });

  it('shows an explicit error when the buyer callback is missing OAuth params', async () => {
    const Component = Route.options.component;
    if (!Component) {
      throw new Error('itch.io callback route component is not defined');
    }

    render(<Component />);

    expect(await screen.findByText('Connection error')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'itch.io' })).toBeInTheDocument();
    expect(screen.getByText('Missing itch.io authorization response.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to dashboard/i })).toHaveAttribute(
      'href',
      'http://localhost:3000/dashboard'
    );

    await waitFor(() => expect(window.location.replace).not.toHaveBeenCalled());
    expect(window.fetch).not.toHaveBeenCalled();
  });

  it('redirects creator setup callbacks back into the begin flow when params are missing', async () => {
    const Component = Route.options.component;
    if (!Component) {
      throw new Error('itch.io callback route component is not defined');
    }

    window.history.replaceState(
      {},
      '',
      '/oauth/callback/itchio?tenant_id=tenant-123&guild_id=guild-456'
    );

    render(<Component />);

    await waitFor(() =>
      expect(window.location.replace).toHaveBeenCalledWith(
        'http://localhost:3000/api/connect/itchio/begin?authUserId=tenant-123&guildId=guild-456'
      )
    );
    expect(window.fetch).not.toHaveBeenCalled();
  });

  it('shows restart guidance when the callback state has expired or was already used', async () => {
    const Component = Route.options.component;
    if (!Component) {
      throw new Error('itch.io callback route component is not defined');
    }

    window.history.replaceState(
      {},
      '',
      '/oauth/callback/itchio#access_token=itch-token&state=verification:itchio:buyer_auth:stale'
    );
    vi.mocked(window.fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'invalid_state' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    render(<Component />);

    expect(await screen.findByText('Connection error')).toBeInTheDocument();
    expect(
      screen.getByText(
        'This itch.io link expired or was already used. Restart verification and try again.'
      )
    ).toBeInTheDocument();
    expect(window.location.replace).not.toHaveBeenCalled();
  });

  it('shows legacy-path guidance when itch.io returns to an unsupported callback flow', async () => {
    const Component = Route.options.component;
    if (!Component) {
      throw new Error('itch.io callback route component is not defined');
    }

    window.history.replaceState(
      {},
      '',
      '/oauth/callback/itchio#access_token=itch-token&state=verification:itchio:buyer_auth:legacy'
    );
    vi.mocked(window.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: 'Verification mode does not support implicit callback: itchio',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    render(<Component />);

    expect(await screen.findByText('Connection error')).toBeInTheDocument();
    expect(
      screen.getByText(
        'This itch.io return link is no longer supported. Start the verification flow again from the latest YUCP screen.'
      )
    ).toBeInTheDocument();
    expect(window.location.replace).not.toHaveBeenCalled();
  });
});
