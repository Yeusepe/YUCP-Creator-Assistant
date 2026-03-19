/**
 * Server API Client Tests
 *
 * These tests verify the server-to-server communication layer between
 * TanStack Start and the Bun API. They catch bugs like:
 * - Missing or wrong auth headers
 * - INTERNAL_RPC_SHARED_SECRET not being forwarded
 * - User auth tokens not being forwarded to Bun
 * - Error responses not surfacing status codes
 * - JSON parsing failures on empty responses
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We test serverApiFetch by mocking global fetch and env vars,
// then importing the module fresh for each test.
const mockFetch = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', mockFetch);

// Must mock the auth-server module since serverApiFetch imports getToken
vi.mock('@/lib/auth-server', () => ({
  getToken: vi.fn().mockResolvedValue('mock-convex-jwt-token'),
  handler: vi.fn(),
  fetchAuthQuery: vi.fn(),
  fetchAuthMutation: vi.fn(),
  fetchAuthAction: vi.fn(),
}));

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('serverApiFetch', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubEnv('INTERNAL_RPC_SHARED_SECRET', 'test-secret-value');
    vi.stubEnv('API_BASE_URL', 'http://localhost:3001');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('falls back to a local development secret when INTERNAL_RPC_SHARED_SECRET is not set', async () => {
    vi.stubEnv('INTERNAL_RPC_SHARED_SECRET', '');
    vi.stubEnv('NODE_ENV', 'development');
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const { serverApiFetch } = await import('@/lib/server/api-client');

    await serverApiFetch('/api/test');

    const [, opts] = mockFetch.mock.calls[0];
    expect((opts as RequestInit).headers).toHaveProperty('Authorization');
  });

  it('throws in production if INTERNAL_RPC_SHARED_SECRET is not set', async () => {
    vi.stubEnv('INTERNAL_RPC_SHARED_SECRET', '');
    vi.stubEnv('NODE_ENV', 'production');
    const { serverApiFetch } = await import('@/lib/server/api-client');

    await expect(serverApiFetch('/api/test')).rejects.toThrow('INTERNAL_RPC_SHARED_SECRET');
  });

  it('sends Authorization header with Bearer secret', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const { serverApiFetch } = await import('@/lib/server/api-client');

    await serverApiFetch('/api/test');

    const [, opts] = mockFetch.mock.calls[0];
    expect((opts as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer test-secret-value',
    });
  });

  it('sends X-Internal-Service header identifying web app', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const { serverApiFetch } = await import('@/lib/server/api-client');

    await serverApiFetch('/api/test');

    const [, opts] = mockFetch.mock.calls[0];
    expect((opts as RequestInit).headers).toMatchObject({
      'X-Internal-Service': 'web',
    });
  });

  it('forwards user auth token as X-Auth-Token when provided', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ guilds: [] }));
    const { serverApiFetch } = await import('@/lib/server/api-client');

    await serverApiFetch('/api/dashboard/guilds', {
      authToken: 'user-jwt-token-123',
    });

    const [, opts] = mockFetch.mock.calls[0];
    expect((opts as RequestInit).headers).toMatchObject({
      'X-Auth-Token': 'user-jwt-token-123',
    });
  });

  it('does NOT send X-Auth-Token when authToken is null', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const { serverApiFetch } = await import('@/lib/server/api-client');

    await serverApiFetch('/api/test', { authToken: null });

    const [, opts] = mockFetch.mock.calls[0];
    const headers = (opts as RequestInit).headers as Record<string, string>;
    expect(headers['X-Auth-Token']).toBeUndefined();
  });

  it('throws with status code and body on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, statusText: 'Forbidden' })
    );
    const { serverApiFetch } = await import('@/lib/server/api-client');

    await expect(serverApiFetch('/api/admin')).rejects.toThrow(/403/);
  });

  it('includes response body text in error message', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('{"error":"invalid token","code":"AUTH_FAILED"}', {
        status: 401,
        statusText: 'Unauthorized',
      })
    );
    const { serverApiFetch } = await import('@/lib/server/api-client');

    await expect(serverApiFetch('/api/protected')).rejects.toThrow(/AUTH_FAILED/);
  });

  it('returns undefined for 204 No Content', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const { serverApiFetch } = await import('@/lib/server/api-client');

    const result = await serverApiFetch('/api/delete');
    expect(result).toBeUndefined();
  });

  it('appends query params to URL', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ results: [] }));
    const { serverApiFetch } = await import('@/lib/server/api-client');

    await serverApiFetch('/api/search', { params: { q: 'test', limit: '10' } });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3001/api/search?q=test&limit=10');
  });

  it('sends JSON body with correct Content-Type for POST', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 1 }));
    const { serverApiFetch } = await import('@/lib/server/api-client');

    await serverApiFetch('/api/items', {
      method: 'POST',
      body: { name: 'Test Item' },
    });

    const [, opts] = mockFetch.mock.calls[0];
    expect((opts as RequestInit).headers).toMatchObject({
      'Content-Type': 'application/json',
    });
    expect((opts as RequestInit).body).toBe(JSON.stringify({ name: 'Test Item' }));
  });

  it('uses API_BASE_URL from environment', async () => {
    vi.stubEnv('API_BASE_URL', 'https://api.production.com');
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const { serverApiFetch } = await import('@/lib/server/api-client');

    await serverApiFetch('/api/health');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.production.com/api/health');
  });

  it('defaults to localhost:3001 when API_BASE_URL not set', async () => {
    vi.stubEnv('API_BASE_URL', '');
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const { serverApiFetch } = await import('@/lib/server/api-client');

    await serverApiFetch('/api/health');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('localhost:3001');
  });
});
