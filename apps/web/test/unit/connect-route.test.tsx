import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { MockApiError, apiClient, navigateMock, useSearchMock } = vi.hoisted(() => {
  class HoistedApiError extends Error {
    status: number;
    body: unknown;

    constructor(status: number, body: unknown) {
      super(`API error ${status}`);
      this.name = 'ApiError';
      this.status = status;
      this.body = body;
    }
  }

  return {
    MockApiError: HoistedApiError,
    apiClient: {
      delete: vi.fn(),
      get: vi.fn(),
      post: vi.fn(),
    },
    navigateMock: vi.fn(),
    useSearchMock: vi.fn(),
  };
});

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({
    options,
    useSearch: useSearchMock,
  }),
  useNavigate: vi.fn(() => navigateMock),
}));

vi.mock('canvas-confetti', () => ({
  default: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  ApiError: MockApiError,
  apiClient,
}));

vi.mock('@/components/page/BackgroundCanvasRoot', () => ({
  BackgroundCanvasRoot: () => null,
}));

vi.mock('@/lib/routeStyles', () => ({
  routeStyleHrefs: { connect: [] },
  routeStylesheetLinks: () => [],
}));

import { Route } from '@/routes/connect';

describe('connect route', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    navigateMock.mockReset();
    useSearchMock.mockReturnValue({
      connect_token: undefined,
      guild_id: '1458860898234929315',
      guildId: undefined,
      setup_token: undefined,
      tenant_id: 'tenant-123',
      tenantId: undefined,
    });
    apiClient.delete.mockReset();
    apiClient.get.mockReset();
    apiClient.post.mockReset();
    apiClient.get.mockRejectedValue(new MockApiError(401, { error: 'Authentication required' }));

    Object.defineProperty(window, 'fetch', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });

    Object.defineProperty(window.location, 'assign', {
      configurable: true,
      value: vi.fn(),
    });

    Object.defineProperty(window.location, 'replace', {
      configurable: true,
      value: vi.fn(),
    });

    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      writable: true,
      value: vi.fn(() => ({
        cancel: vi.fn(),
        finished: Promise.resolve(),
      })),
    });

    window.history.replaceState({}, '', '/connect?guild_id=1458860898234929315');
  });

  it('redirects compatibility connect links into the dashboard route', async () => {
    const Component = Route.options.component;
    if (!Component) {
      throw new Error('Connect route component is not defined');
    }

    window.history.replaceState(
      {},
      '',
      '/connect?guild_id=1458860898234929315&tenant_id=tenant-123#token=connect-token-123'
    );

    render(<Component />);

    await waitFor(() =>
      expect(window.location.replace).toHaveBeenCalledWith(
        'http://localhost:3000/dashboard?guild_id=1458860898234929315&tenant_id=tenant-123#token=connect-token-123'
      )
    );
  });
});
