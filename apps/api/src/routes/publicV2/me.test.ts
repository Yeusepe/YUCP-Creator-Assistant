import { describe, expect, it, mock } from 'bun:test';
import { API_VERSION } from './helpers';

// --- Module mock — must appear before the dynamic import of me.ts ---
mock.module('./auth', () => ({
  resolveAuth: async () => ({
    authUserId: 'user_abc',
    scopes: ['subjects:read', 'entitlements:read'],
    keyId: 'key_123',
    expiresAt: null,
  }),
}));

const { handleMeRoutes } = await import('./me');

const config = {
  convexUrl: 'https://test.convex.cloud',
  convexApiSecret: 'test-secret',
  convexSiteUrl: 'https://test.convex.site',
  encryptionSecret: 'test-enc',
};

function makeRequest(method = 'GET', headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/public/v2/me', {
    method,
    headers: { authorization: 'Bearer test-token', ...headers },
  });
}

describe('handleMeRoutes', () => {
  describe('GET /me', () => {
    it('returns 200 with api_key_info object', async () => {
      const res = await handleMeRoutes(makeRequest(), '/me', config);
      expect(res.status).toBe(200);
    });

    it('body has the expected api_key_info shape', async () => {
      const res = await handleMeRoutes(makeRequest(), '/me', config);
      const body = await res.json() as Record<string, unknown>;
      expect(body.object).toBe('api_key_info');
      expect(body.authUserId).toBe('user_abc');
      expect(body.scopes).toEqual(['subjects:read', 'entitlements:read']);
      expect(body.keyId).toBe('key_123');
      expect(body.expiresAt).toBeNull();
    });

    it('includes Yucp-Version header', async () => {
      const res = await handleMeRoutes(makeRequest(), '/me', config);
      expect(res.headers.get('Yucp-Version')).toBe(API_VERSION);
    });

    it('includes X-Request-Id header', async () => {
      const res = await handleMeRoutes(makeRequest(), '/me', config);
      expect(res.headers.get('X-Request-Id')).toMatch(/^req_/);
    });

    it('includes Content-Type: application/json', async () => {
      const res = await handleMeRoutes(makeRequest(), '/me', config);
      expect(res.headers.get('Content-Type')).toBe('application/json');
    });
  });

  describe('unsupported methods on /me', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      it(`returns 405 for ${method} /me`, async () => {
        const res = await handleMeRoutes(makeRequest(method), '/me', config);
        expect(res.status).toBe(405);
        const body = await res.json() as Record<string, unknown>;
        expect(body.error).toBe('method_not_allowed');
      });
    }
  });

  describe('wrong sub-paths', () => {
    it('returns 404 for /me/extra', async () => {
      const res = await handleMeRoutes(makeRequest(), '/me/extra', config);
      expect(res.status).toBe(404);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe('not_found');
    });

    it('returns 404 for /me/profile', async () => {
      const res = await handleMeRoutes(makeRequest(), '/me/profile', config);
      expect(res.status).toBe(404);
    });
  });
});
