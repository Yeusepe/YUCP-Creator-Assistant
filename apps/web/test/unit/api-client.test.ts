import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient, apiFetch } from '@/api/client';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
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
