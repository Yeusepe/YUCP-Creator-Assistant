import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addHyperdxAction, captureHyperdxException } = vi.hoisted(() => ({
  addHyperdxAction: vi.fn(),
  captureHyperdxException: vi.fn(),
}));

vi.mock('@/lib/hyperdx', () => ({
  addHyperdxAction,
  captureHyperdxException,
}));

import { ApiError, apiClient, apiFetch, parseServerTimingHeader } from '@/api/client';

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
      new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    );

    await expect(apiFetch('/api/missing')).rejects.toThrow(ApiError);
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

  it('upload() sends raw bytes with credentials, query parameters, and progress', async () => {
    class MockXMLHttpRequest {
      static current: MockXMLHttpRequest | undefined;
      readonly headers = new Map<string, string>();
      readonly upload: { onprogress?: (event: ProgressEvent) => void } = {};
      method = '';
      onerror?: () => void;
      onload?: () => void;
      responseText = '';
      status = 0;
      url = '';
      withCredentials = false;

      constructor() {
        MockXMLHttpRequest.current = this;
      }

      getResponseHeader() {
        return null;
      }

      open(method: string, url: string) {
        this.method = method;
        this.url = url;
      }

      send = vi.fn();

      setRequestHeader(name: string, value: string) {
        this.headers.set(name.toLowerCase(), value);
      }
    }
    vi.stubGlobal('XMLHttpRequest', MockXMLHttpRequest);
    const body = new Blob(['Lore source bytes']);
    const onProgress = vi.fn();

    const resultPromise = apiClient.upload<{ loreSource: { address: string } }>(
      '/api/packages/pkg_1/backstage/upload',
      body,
      {
        headers: { 'Content-Type': 'application/zip' },
        params: {
          deliveryName: 'package.zip',
          sha256: 'f'.repeat(64),
          sourceContentType: 'application/zip',
        },
        onProgress,
      }
    );
    const request = MockXMLHttpRequest.current;
    expect(request).toBeDefined();
    if (!request) {
      throw new Error('Expected upload request to be created');
    }
    request.upload.onprogress?.({
      lengthComputable: true,
      loaded: 8,
      total: 16,
    } as ProgressEvent);
    request.status = 200;
    request.responseText = JSON.stringify({ loreSource: { address: `sha256:${'f'.repeat(64)}` } });
    request.onload?.();

    await expect(resultPromise).resolves.toEqual({
      loreSource: { address: `sha256:${'f'.repeat(64)}` },
    });
    expect(request.method).toBe('POST');
    expect(request.url).toContain('/api/packages/pkg_1/backstage/upload?');
    expect(request.url).toContain(`sha256=${'f'.repeat(64)}`);
    expect(request.url).toContain('deliveryName=package.zip');
    expect(request.url).toContain('sourceContentType=application%2Fzip');
    expect(request.withCredentials).toBe(true);
    expect(request.headers.get('content-type')).toBe('application/zip');
    expect(request.send).toHaveBeenCalledWith(body);
    expect(onProgress).toHaveBeenCalledWith({ loaded: 8, total: 16 });
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
