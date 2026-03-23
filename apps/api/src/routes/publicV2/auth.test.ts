import { beforeEach, describe, expect, it, mock } from 'bun:test';

// --- Module mocks (must appear before any import that transitively uses them) ---

let mutationImpl: (fn: unknown, args: unknown) => Promise<unknown>;
let verifyBetterAuthImpl: (token: string, opts: unknown) => Promise<unknown>;

const mutationMock = mock((fn: unknown, args: unknown) => mutationImpl(fn, args));
const verifyBetterAuthMock = mock((token: string, opts: unknown) =>
  verifyBetterAuthImpl(token, opts)
);

mock.module('../../../../../convex/_generated/api', () => ({
  api: { betterAuthApiKeys: { verifyApiKey: 'mock-verify-key' } },
}));

mock.module('../../lib/convex', () => ({
  getConvexClientFromUrl: () => ({ mutation: mutationMock }),
}));

mock.module('../../lib/oauthAccessToken', () => ({
  verifyBetterAuthAccessToken: verifyBetterAuthMock,
}));

const { resolveAuth } = await import('./auth');
const { RouteTimingCollector } = await import('../../lib/requestTiming');

// --- Shared fixtures ---

const VALID_API_KEY = `ypsk_${'a'.repeat(48)}`;

const config = {
  convexUrl: 'https://test.convex.cloud',
  convexApiSecret: 'test-secret',
  convexSiteUrl: 'https://test.convex.site',
  encryptionSecret: 'test-enc-secret',
};

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/public/v2/me', { headers });
}

function validKeyResult(scopes: string[] = []) {
  return {
    key: {
      id: 'key_id_abc',
      metadata: { authUserId: 'user_abc' },
      permissions: { publicApi: scopes },
      expiresAt: null,
    },
  };
}

beforeEach(() => {
  mutationMock.mockClear();
  verifyBetterAuthMock.mockClear();
  mutationImpl = async () => null;
  verifyBetterAuthImpl = async () => ({ ok: false, reason: 'invalid' });
});

describe('resolveAuth', () => {
  describe('missing credentials', () => {
    it('returns 401 when neither x-api-key nor Authorization header is present', async () => {
      const result = await resolveAuth(makeRequest(), config, []);
      expect(result instanceof Response).toBe(true);
      expect((result as Response).status).toBe(401);
      const body = (await (result as Response).json()) as Record<string, unknown>;
      expect(body.error).toBe('unauthorized');
    });

    it('returns 401 when Authorization header is present but empty after Bearer prefix', async () => {
      const result = await resolveAuth(makeRequest({ authorization: 'Bearer ' }), config, []);
      expect((result as Response).status).toBe(401);
    });
  });

  describe('x-api-key header — format validation', () => {
    it('returns 401 for a key with wrong prefix', async () => {
      const result = await resolveAuth(
        makeRequest({ 'x-api-key': `sk_${'a'.repeat(48)}` }),
        config,
        []
      );
      expect((result as Response).status).toBe(401);
    });

    it('returns 401 for a key that is too short', async () => {
      const result = await resolveAuth(
        makeRequest({ 'x-api-key': `ypsk_${'a'.repeat(10)}` }),
        config,
        []
      );
      expect((result as Response).status).toBe(401);
    });

    it('returns 401 for a key that contains invalid (non-hex) characters', async () => {
      const result = await resolveAuth(
        makeRequest({ 'x-api-key': `ypsk_${'z'.repeat(48)}` }),
        config,
        []
      );
      expect((result as Response).status).toBe(401);
    });
  });

  describe('x-api-key header — Convex verification', () => {
    it('returns 401 when Convex returns null (key not found or expired)', async () => {
      mutationImpl = async () => null;
      const result = await resolveAuth(makeRequest({ 'x-api-key': VALID_API_KEY }), config, []);
      expect((result as Response).status).toBe(401);
    });

    it('returns 401 when the key object has no authUserId in metadata', async () => {
      mutationImpl = async () => ({
        key: { id: 'key_id', metadata: {}, permissions: { publicApi: [] } },
      });
      const result = await resolveAuth(makeRequest({ 'x-api-key': VALID_API_KEY }), config, []);
      expect((result as Response).status).toBe(401);
    });

    it('returns 403 when the key exists but is missing a required scope', async () => {
      mutationImpl = async () => validKeyResult([]);
      const result = await resolveAuth(makeRequest({ 'x-api-key': VALID_API_KEY }), config, [
        'subjects:read',
      ]);
      expect((result as Response).status).toBe(403);
      const body = (await (result as Response).json()) as Record<string, unknown>;
      expect(body.error).toBe('forbidden');
    });

    it('returns AuthResult when key is valid and required scopes are satisfied', async () => {
      mutationImpl = async () => validKeyResult(['subjects:read', 'entitlements:read']);
      const result = await resolveAuth(makeRequest({ 'x-api-key': VALID_API_KEY }), config, [
        'subjects:read',
      ]);
      expect(result instanceof Response).toBe(false);
      const auth = result as { authUserId: string; scopes: string[] };
      expect(auth.authUserId).toBe('user_abc');
      expect(auth.scopes).toContain('subjects:read');
    });

    it('succeeds with no required scopes even if the key has an empty permission set', async () => {
      mutationImpl = async () => validKeyResult([]);
      const result = await resolveAuth(makeRequest({ 'x-api-key': VALID_API_KEY }), config, []);
      expect(result instanceof Response).toBe(false);
    });

    it('records auth timing metrics when a collector is provided', async () => {
      mutationImpl = async () => validKeyResult(['subjects:read']);
      const timing = new RouteTimingCollector();

      const result = await resolveAuth(
        makeRequest({ 'x-api-key': VALID_API_KEY }),
        config,
        ['subjects:read'],
        'req_timing_auth_123456',
        timing
      );

      expect(result instanceof Response).toBe(false);
      expect(timing.toServerTimingHeader()).toMatch(/auth_api_key;dur=.*total;dur=/);
    });

    it('includes keyId and expiresAt in the returned AuthResult', async () => {
      mutationImpl = async () => ({
        key: {
          id: 'key_id_xyz',
          metadata: { authUserId: 'user_abc' },
          permissions: { publicApi: [] },
          expiresAt: 9_999_999_999,
        },
      });
      const result = await resolveAuth(makeRequest({ 'x-api-key': VALID_API_KEY }), config, []);
      const auth = result as { keyId: string; expiresAt: number };
      expect(auth.keyId).toBe('key_id_xyz');
      expect(auth.expiresAt).toBe(9_999_999_999);
    });
  });

  describe('Bearer header with ypsk_ API key', () => {
    it('routes to API-key path and succeeds', async () => {
      mutationImpl = async () => validKeyResult(['subjects:read']);
      const result = await resolveAuth(
        makeRequest({ authorization: `Bearer ${VALID_API_KEY}` }),
        config,
        ['subjects:read']
      );
      expect(result instanceof Response).toBe(false);
      expect(mutationMock.mock.calls).toHaveLength(1);
      expect(verifyBetterAuthMock.mock.calls).toHaveLength(0);
    });
  });

  describe('OAuth Bearer JWT token', () => {
    it('returns 403 when verifyBetterAuthAccessToken reports insufficient_scope', async () => {
      verifyBetterAuthImpl = async () => ({ ok: false, reason: 'insufficient_scope' });
      const result = await resolveAuth(
        makeRequest({ authorization: 'Bearer some.jwt.token' }),
        config,
        ['subjects:read']
      );
      expect((result as Response).status).toBe(403);
      const body = (await (result as Response).json()) as Record<string, unknown>;
      expect(body.error).toBe('forbidden');
    });

    it('returns 401 for any other failure reason', async () => {
      verifyBetterAuthImpl = async () => ({ ok: false, reason: 'invalid' });
      const result = await resolveAuth(
        makeRequest({ authorization: 'Bearer some.jwt.token' }),
        config,
        []
      );
      expect((result as Response).status).toBe(401);
      const body = (await (result as Response).json()) as Record<string, unknown>;
      expect(body.error).toBe('unauthorized');
    });

    it('returns AuthResult with sub and grantedScopes when token is valid', async () => {
      verifyBetterAuthImpl = async () => ({
        ok: true,
        token: { sub: 'user_jwt_123', grantedScopes: ['subjects:read', 'entitlements:read'] },
      });
      const result = await resolveAuth(
        makeRequest({ authorization: 'Bearer valid.jwt.token' }),
        config,
        ['subjects:read']
      );
      expect(result instanceof Response).toBe(false);
      const auth = result as { authUserId: string; scopes: string[] };
      expect(auth.authUserId).toBe('user_jwt_123');
      expect(auth.scopes).toEqual(['subjects:read', 'entitlements:read']);
    });

    it('does not call Convex mutation when using a JWT bearer token', async () => {
      verifyBetterAuthImpl = async () => ({
        ok: true,
        token: { sub: 'user_jwt', grantedScopes: [] },
      });
      await resolveAuth(makeRequest({ authorization: 'Bearer jwt.only.token' }), config, []);
      expect(mutationMock.mock.calls).toHaveLength(0);
    });
  });
});
