import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('canvas-confetti', () => ({
  default: vi.fn(),
}));

vi.mock('@/components/page/BackgroundCanvasRoot', () => ({
  BackgroundCanvasRoot: () => null,
}));

import { Route } from '@/routes/setup/jinxxy';

describe('Jinxxy setup route', () => {
  beforeEach(() => {
    vi.restoreAllMocks();

    Object.defineProperty(window, 'fetch', {
      writable: true,
      value: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ callbackUrl: 'https://example.com/webhook' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      ),
    });

    window.history.replaceState({}, '', '/setup/jinxxy?tenant_id=tenant-123');
  });

  it('requests webhook config with authUserId when a tenant is present', async () => {
    const Component = Route.options.component;
    if (!Component) {
      throw new Error('Jinxxy setup route component is not defined');
    }

    render(<Component />);

    fireEvent.click(await screen.findByRole('button', { name: /next step/i }));
    fireEvent.click(await screen.findByRole('button', { name: /next step/i }));

    await waitFor(() =>
      expect(window.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/connect/jinxxy/webhook-config?authUserId=tenant-123'),
        expect.objectContaining({ credentials: 'include' })
      )
    );
  });
});
