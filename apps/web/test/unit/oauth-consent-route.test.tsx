import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { consentMock } = vi.hoisted(() => ({
  consentMock: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({
    options,
  }),
}));

vi.mock('@/components/page/BackgroundCanvasRoot', () => ({
  BackgroundCanvasRoot: () => null,
}));

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    oauth2: {
      consent: consentMock,
    },
  },
}));

import { Route } from '@/routes/oauth/consent';

describe('oauth consent route', () => {
  beforeEach(() => {
    consentMock.mockReset();
    consentMock.mockResolvedValue({
      data: {
        url: 'http://127.0.0.1:50481/callback?code=test',
      },
      error: null,
    });

    Object.defineProperty(window, 'alert', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });

    Object.defineProperty(window.location, 'href', {
      configurable: true,
      writable: true,
      value: 'http://localhost:3000/oauth/consent?client_id=yucp-unity-editor&scope=cert%3Aissue',
    });

    window.history.replaceState(
      {},
      '',
      '/oauth/consent?client_id=yucp-unity-editor&scope=cert%3Aissue'
    );
  });

  it('submits consent through the Better Auth oauth provider client', async () => {
    const Component = Route.options.component;
    if (!Component) {
      throw new Error('OAuth consent route component is not defined');
    }

    render(<Component />);

    fireEvent.click(await screen.findByRole('button', { name: /allow access/i }));

    await waitFor(() => {
      expect(consentMock).toHaveBeenCalledWith({
        accept: true,
      });
    });

    expect(window.location.href).toBe('http://127.0.0.1:50481/callback?code=test');
  });
});
