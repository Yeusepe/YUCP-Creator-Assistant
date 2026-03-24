import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { API_VERSION } from './helpers';

let resolveAuthResult: unknown;
let profileQueryImpl: (...args: unknown[]) => Promise<unknown>;
let lastResolveAuthScopes: string[] | null;
let lastConvexQueryCall: unknown[] | null;

const resolveAuthMock = mock(async (...args: unknown[]) => {
  lastResolveAuthScopes = (args[2] as string[]) ?? null;
  return resolveAuthResult;
});

const convexQueryMock = mock(async (...args: unknown[]) => {
  lastConvexQueryCall = args;
  return profileQueryImpl(...args);
});

mock.module('./auth', () => ({
  resolveAuth: resolveAuthMock,
}));

mock.module('../../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    query: convexQueryMock,
  }),
}));

mock.module('../../../../../convex/_generated/api', () => ({
  api: {
    authViewer: {
      getViewerByAuthUser: 'authViewer.getViewerByAuthUser',
    },
  },
}));

const { handleMeRoutes } = await import('./me');

const config = {
  convexUrl: 'https://test.convex.cloud',
  convexApiSecret: 'test-secret',
  convexSiteUrl: 'https://test.convex.site',
  encryptionSecret: 'test-enc',
  frontendBaseUrl: 'https://creators.test',
};

function makeRequest(path = '/me', method = 'GET', headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/public/v2${path}`, {
    method,
    headers: { authorization: 'Bearer test-token', ...headers },
  });
}

describe('handleMeRoutes', () => {
  beforeEach(() => {
    resolveAuthResult = {
      authUserId: 'user_abc',
      scopes: ['subjects:read', 'entitlements:read'],
      keyId: 'key_123',
      expiresAt: null,
    };
    lastResolveAuthScopes = null;
    lastConvexQueryCall = null;
    profileQueryImpl = async () => ({
      authUserId: 'user_abc',
      name: 'Creator User',
      image: 'https://cdn.example.com/avatar.png',
      email: 'creator@example.com',
      discordUserId: null,
    });
  });

  describe('GET /me', () => {
    it('returns 200 with api_key_info object', async () => {
      const res = await handleMeRoutes(makeRequest('/me'), '/me', config);
      expect(res.status).toBe(200);
    });

    it('body has the expected api_key_info shape', async () => {
      const res = await handleMeRoutes(makeRequest('/me'), '/me', config);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.object).toBe('api_key_info');
      expect(body.authUserId).toBe('user_abc');
      expect(body.scopes).toEqual(['subjects:read', 'entitlements:read']);
      expect(body.keyId).toBe('key_123');
      expect(body.expiresAt).toBeNull();
    });

    it('includes Yucp-Version header', async () => {
      const res = await handleMeRoutes(makeRequest('/me'), '/me', config);
      expect(res.headers.get('Yucp-Version')).toBe(API_VERSION);
    });

    it('includes X-Request-Id header', async () => {
      const res = await handleMeRoutes(makeRequest('/me'), '/me', config);
      expect(res.headers.get('X-Request-Id')).toMatch(/^req_/);
    });

    it('includes Content-Type: application/json', async () => {
      const res = await handleMeRoutes(makeRequest('/me'), '/me', config);
      expect(res.headers.get('Content-Type')).toBe('application/json');
    });
  });

  describe('unsupported methods on /me', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      it(`returns 405 for ${method} /me`, async () => {
        const res = await handleMeRoutes(makeRequest('/me', method), '/me', config);
        expect(res.status).toBe(405);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.error).toBe('method_not_allowed');
      });
    }
  });

  describe('GET /me/profile', () => {
    it('returns 200 with the profile resource shape', async () => {
      const res = await handleMeRoutes(makeRequest('/me/profile'), '/me/profile', config);
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        object: 'profile',
        authUserId: 'user_abc',
        name: 'Creator User',
        image: 'https://cdn.example.com/avatar.png',
      });
    });

    it('requires the profile:read scope and queries the canonical viewer lookup', async () => {
      const res = await handleMeRoutes(makeRequest('/me/profile'), '/me/profile', config);
      expect(res.status).toBe(200);

      expect(lastResolveAuthScopes).toEqual(['profile:read']);
      expect(lastConvexQueryCall).toEqual([
        'authViewer.getViewerByAuthUser',
        {
          apiSecret: 'test-secret',
          authUserId: 'user_abc',
        },
      ]);
    });

    it('returns 404 when the profile cannot be found', async () => {
      profileQueryImpl = async () => null;

      const res = await handleMeRoutes(makeRequest('/me/profile'), '/me/profile', config);
      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('not_found');
    });

    it('returns 500 when the viewer lookup fails', async () => {
      profileQueryImpl = async () => {
        throw new Error('lookup failed');
      };

      const res = await handleMeRoutes(makeRequest('/me/profile'), '/me/profile', config);
      expect(res.status).toBe(500);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('internal_error');
    });
  });

  describe('unsupported methods on /me/profile', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      it(`returns 405 for ${method} /me/profile`, async () => {
        const res = await handleMeRoutes(makeRequest('/me/profile', method), '/me/profile', config);
        expect(res.status).toBe(405);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.error).toBe('method_not_allowed');
      });
    }
  });

  describe('wrong sub-paths', () => {
    it('returns 404 for /me/extra', async () => {
      const res = await handleMeRoutes(makeRequest('/me/extra'), '/me/extra', config);
      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('not_found');
    });
  });
});
