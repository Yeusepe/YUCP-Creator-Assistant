import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addHyperdxAction, captureHyperdxException } = vi.hoisted(() => ({
  addHyperdxAction: vi.fn(),
  captureHyperdxException: vi.fn(),
}));

vi.mock('@/lib/hyperdx', () => ({
  addHyperdxAction,
  captureHyperdxException,
}));

import { apiClient, apiFetch, fetchWithDiagnostics, parseServerTimingHeader } from '@/api/client';
import { savePrivacyPreferences } from '@/lib/privacyPreferences';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
  addHyperdxAction.mockReset();
  captureHyperdxException.mockReset();
});

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('apiFetch', () => {
  it('makes requests with credentials: include', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await apiFetch('/api/test');

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/test',
      expect.objectContaining({ credentials: 'include' })
    );
  });

  it('parses JSON response', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ items: [1, 2, 3] }));

    const data = await apiFetch('/api/items');
    expect(data).toEqual({ items: [1, 2, 3] });
  });

  it('throws ApiError on non-ok responses', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'not found', token: 'secret-value' }), { status: 404 })
    );

    await expect(apiFetch('/api/missing')).rejects.toMatchObject({
      name: 'ApiError',
      body: { error: 'not found', token: 'secret-value' },
    });
    expect(captureHyperdxException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'First-party API request failed with status 404',
      }),
      expect.objectContaining({
        path: '/api/missing',
        status: '404',
      })
    );
    expect(JSON.stringify(captureHyperdxException.mock.calls[0])).not.toContain('secret-value');
  });

  it('captures transport failures without including request bodies', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network unavailable'));

    await expect(
      apiFetch('/api/items', {
        method: 'POST',
        body: JSON.stringify({ apiKey: 'secret-value' }),
      })
    ).rejects.toThrow('network unavailable');

    expect(captureHyperdxException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        path: '/api/items',
        networkFailure: true,
      })
    );
    expect(JSON.stringify(captureHyperdxException.mock.calls[0])).not.toContain('secret-value');
  });

  it('appends query params when provided', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));

    await apiFetch('/api/search', { params: { q: 'test', page: '1' } });

    expect(mockFetch).toHaveBeenCalledWith('/api/search?q=test&page=1', expect.anything());
  });

  it('returns undefined for 204 responses', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await apiFetch('/api/delete-thing');
    expect(result).toBeUndefined();
  });

  it('emits request stage actions from Server-Timing', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': 'req_123',
          'Server-Timing': 'session;dur=12.5,convex;dur=48.75,total;dur=80.1',
        },
      })
    );

    await apiFetch('/api/connect/accounts');

    expect(addHyperdxAction).toHaveBeenCalledWith(
      'api.request.completed',
      expect.objectContaining({
        path: '/api/connect/accounts',
        requestId: 'req_123',
        routeCategory: 'connect',
        serverTimingStageCount: '3',
        serverTimingTotalMs: '80.1',
      })
    );
    expect(addHyperdxAction).toHaveBeenCalledWith(
      'api.request.stage',
      expect.objectContaining({
        path: '/api/connect/accounts',
        stage: 'session',
        durationMs: '12.5',
      })
    );
    expect(addHyperdxAction).toHaveBeenCalledWith(
      'api.request.stage',
      expect.objectContaining({
        path: '/api/connect/accounts',
        stage: 'convex',
        durationMs: '48.75',
      })
    );
  });
});

describe('fetchWithDiagnostics', () => {
  it('propagates the diagnostics session only after consent and keeps query values out of actions', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    savePrivacyPreferences('helpful-diagnostics', 'banner');

    await fetchWithDiagnostics('/api/oauth/authorize?token=secret-value');

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers.get('X-YUCP-Diagnostics-Session')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(addHyperdxAction).toHaveBeenCalledWith(
      'first-party.request.completed',
      expect.objectContaining({ path: '/api/oauth/authorize' })
    );
    expect(JSON.stringify(addHyperdxAction.mock.calls)).not.toContain('secret-value');
  });

  it('does not attach the diagnostics session to cross-origin requests', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    savePrivacyPreferences('helpful-diagnostics', 'banner');

    await fetchWithDiagnostics('https://third-party.example.test/api/collect');

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers.get('X-YUCP-Diagnostics-Session')).toBeNull();
  });
});

describe('parseServerTimingHeader', () => {
  it('parses metric names and durations', () => {
    expect(parseServerTimingHeader('session;dur=12.5, total;dur=48')).toEqual([
      { name: 'session', durationMs: 12.5 },
      { name: 'total', durationMs: 48 },
    ]);
  });

  it('returns an empty array when the header is missing', () => {
    expect(parseServerTimingHeader(null)).toEqual([]);
  });
});

describe('apiClient convenience methods', () => {
  it('get() sends a GET request', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ items: [] }));

    const data = await apiClient.get('/api/items');
    expect(data).toEqual({ items: [] });
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/items',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('post() sends a POST with JSON body', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 1 }));

    const data = await apiClient.post('/api/items', { name: 'New' });
    expect(data).toEqual({ id: 1 });
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.method).toBe('POST');
    expect(opts.body).toBe(JSON.stringify({ name: 'New' }));
  });

  it('put() sends a PUT with JSON body', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ updated: true }));

    await apiClient.put('/api/items/1', { name: 'Updated' });
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.method).toBe('PUT');
  });

  it('delete() sends a DELETE request', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ deleted: true }));

    await apiClient.delete('/api/items/1');
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.method).toBe('DELETE');
  });
});
