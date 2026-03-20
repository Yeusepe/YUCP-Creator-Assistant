/**
 * VrchatApiClient unit tests — TDD
 *
 * Tests for new methods added as part of the VRChat provider plugin migration:
 * - getProductListings: fetches creator store listings (GET /user/{userId}/listings)
 * - getOwnershipFromSession: now also collects avatar.productId into ownedAvatarIds
 *
 * API reference:
 *   getProductListings → https://vrchat.community/reference/get-product-listings
 *   OpenAPI spec → https://github.com/vrchatapi/specification/blob/main/openapi/components/paths/economy.yaml
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';
import { VrchatApiClient } from './client';
import { VrchatSessionExpiredError } from './types';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('VrchatApiClient.beginLogin', () => {
  it('calls GET /auth/user with Basic auth only — no ?apiKey= and no /config bootstrap', async () => {
    // VRChat spec: /auth/user has parameters: [] and security: [{authHeader: []}].
    // The ?apiKey= query parameter must NOT be sent to /auth/user — VRChat returns 401 when it is.
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url, headers });

      if (url.includes('/auth/user')) {
        const responseHeaders = new Headers();
        responseHeaders.append('set-cookie', 'auth=auth-token; Path=/; HttpOnly');
        return new Response(JSON.stringify({ id: 'usr_123', displayName: 'Display' }), {
          status: 200,
          headers: responseHeaders,
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new VrchatApiClient();
    const result = await client.beginLogin('user@example.com', 'p@ss word');

    // Must be exactly 1 fetch call — no /config bootstrap for the login endpoint
    expect(calls).toHaveLength(1);

    // /auth/user: NO ?apiKey= (would cause 401), NO cookie, correct Basic auth
    expect(calls[0]?.url).toContain('/auth/user');
    expect(calls[0]?.url).not.toContain('apiKey=');
    expect(calls[0]?.headers.get('cookie')).toBeNull();
    expect(calls[0]?.headers.get('authorization')).toBe(
      `Basic ${Buffer.from(
        `${encodeURIComponent('user@example.com')}:${encodeURIComponent('p@ss word')}`,
        'utf-8'
      ).toString('base64')}`
    );
    expect(calls[0]?.headers.get('user-agent')).toContain('YUCP Creator Assistant');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.session.authToken).toBe('auth-token');
      expect(result.user.id).toBe('usr_123');
    }
  });

  it('returns pending 2FA state when VRChat requires two-factor auth', async () => {
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      if (url.includes('/auth/user')) {
        expect(url).not.toContain('apiKey=');
        const responseHeaders = new Headers();
        responseHeaders.append('set-cookie', 'auth=auth-token-2fa; Path=/; HttpOnly');
        return new Response(JSON.stringify({ requiresTwoFactorAuth: ['totp', 'emailOtp'] }), {
          status: 200,
          headers: responseHeaders,
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new VrchatApiClient();
    const result = await client.beginLogin('username', 'password');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.requiresTwoFactorAuth).toContain('totp');
      expect(result.requiresTwoFactorAuth).toContain('emailOtp');
      expect(result.pendingState).toBeTruthy();
    }
  });

  it('throws when VRChat returns 401 (invalid credentials)', async () => {
    const fetchMock = mock(async (url: string) => {
      if (url.includes('/auth/user')) {
        expect(url).not.toContain('apiKey=');
        return new Response(
          JSON.stringify({ error: { message: '"Missing Credentials"', status_code: 401 } }),
          { status: 401 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new VrchatApiClient();
    await expect(client.beginLogin('bad', 'creds')).rejects.toThrow(
      'Verification failed: missing auth cookie (status 401)'
    );
  });
});

describe('VrchatApiClient.completePendingLogin', () => {
  it('fetches /config and sends clientApiKey as ?apiKey= URL param (not header) in 2FA and current-user requests', async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url, headers });

      if (url.includes('/config')) {
        return new Response(JSON.stringify({ clientApiKey: 'test-key' }), {
          status: 200,
        });
      }

      if (url.includes('/auth/twofactorauth/totp/verify')) {
        const responseHeaders = new Headers();
        responseHeaders.append('set-cookie', 'auth=auth-token-verified; Path=/; HttpOnly');
        responseHeaders.append('set-cookie', 'twoFactorAuth=two-factor-token; Path=/; HttpOnly');
        return new Response(JSON.stringify({ verified: true, enabled: true }), {
          status: 200,
          headers: responseHeaders,
        });
      }

      if (url.includes('/auth/user')) {
        return new Response(JSON.stringify({ id: 'usr_2fa', displayName: 'Two Factor User' }), {
          status: 200,
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new VrchatApiClient();
    const pendingState = JSON.stringify({
      authToken: 'pending-auth-token',
      requiresTwoFactorAuth: ['totp'],
    });

    const result = await client.completePendingLogin(pendingState, '123456');

    expect(calls).toHaveLength(3);
    // /config: no apiKey in URL
    expect(calls[0]?.url).toContain('/config');
    expect(calls[0]?.url).not.toContain('apiKey=');

    // 2FA verify: apiKey in URL, not as header
    expect(calls[1]?.url).toContain('/auth/twofactorauth/totp/verify');
    expect(calls[1]?.url).toContain('apiKey=test-key');
    expect(calls[1]?.headers.get('clientApiKey')).toBeNull();
    expect(calls[1]?.headers.get('cookie')).toBe('auth=pending-auth-token');

    // current user after 2FA: apiKey in URL, not as header
    expect(calls[2]?.url).toContain('/auth/user');
    expect(calls[2]?.url).toContain('apiKey=test-key');
    expect(calls[2]?.headers.get('clientApiKey')).toBeNull();
    expect(calls[2]?.headers.get('cookie')).toBe(
      'auth=auth-token-verified; twoFactorAuth=two-factor-token'
    );

    expect(result.user.id).toBe('usr_2fa');
    expect(result.session.authToken).toBe('auth-token-verified');
    expect(result.session.twoFactorAuthToken).toBe('two-factor-token');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// getProductListings
// ──────────────────────────────────────────────────────────────────────────────

describe('VrchatApiClient.getProductListings', () => {
  it('returns listings mapped from GET /user/{userId}/listings', async () => {
    // First call: GET /config → get clientApiKey
    // Second call: GET /auth/user?apiKey=test-key → get userId
    // Third call: GET /user/usr_abc/listings?apiKey=test-key → get listings
    let callCount = 0;
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      callCount++;
      const headers = new Headers(init?.headers);

      if (url.includes('/config')) {
        expect(headers.get('cookie')).toBeNull();
        expect(url).not.toContain('apiKey=');
        return new Response(JSON.stringify({ clientApiKey: 'test-key' }), {
          status: 200,
        });
      }

      // All non-config requests must carry apiKey in URL
      expect(url).toContain('apiKey=test-key');
      expect(headers.get('clientApiKey')).toBeNull();
      expect(headers.get('cookie')).toContain('auth=auth-token');

      if (url.includes('/auth/user')) {
        return new Response(JSON.stringify({ id: 'usr_abc', displayName: 'Creator' }), {
          status: 200,
        });
      }

      if (url.includes('/user/usr_abc/listings')) {
        return new Response(
          JSON.stringify([
            {
              id: 'prod_aaa',
              displayName: 'Avatar Pack',
              listingType: 'permanent',
              hasAvatar: true,
              sellerId: 'usr_abc',
            },
            {
              id: 'prod_bbb',
              displayName: 'Subscription Bundle',
              listingType: 'subscription',
              hasAvatar: true,
              sellerId: 'usr_abc',
            },
          ]),
          { status: 200 }
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new VrchatApiClient();
    const listings = await client.getProductListings({ authToken: 'auth-token' });

    expect(callCount).toBe(3);
    expect(listings).toHaveLength(2);
    expect(listings[0].id).toBe('prod_aaa');
    expect(listings[0].displayName).toBe('Avatar Pack');
    expect(listings[0].listingType).toBe('permanent');
    expect(listings[1].id).toBe('prod_bbb');
    expect(listings[1].listingType).toBe('subscription');
  });

  it('includes twoFactorAuthToken in cookie when present', async () => {
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);

      if (url.includes('/config')) {
        expect(headers.get('cookie')).toBeNull();
        return new Response(JSON.stringify({ clientApiKey: 'test-key' }), {
          status: 200,
        });
      }

      expect(url).toContain('apiKey=test-key');
      expect(headers.get('clientApiKey')).toBeNull();
      expect(headers.get('cookie')).toContain('auth=tok; twoFactorAuth=two');

      if (url.includes('/auth/user')) {
        return new Response(JSON.stringify({ id: 'usr_xyz', displayName: 'User' }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new VrchatApiClient();
    const listings = await client.getProductListings({
      authToken: 'tok',
      twoFactorAuthToken: 'two',
    });
    expect(listings).toHaveLength(0);
  });

  it('throws VrchatSessionExpiredError when getCurrentUser returns null (session expired)', async () => {
    const fetchMock = mock(async (url: string) => {
      if (url.includes('/config')) {
        return new Response(JSON.stringify({ clientApiKey: 'test-key' }), {
          status: 200,
        });
      }

      if (url.includes('/auth/user')) {
        // 401 means session expired; the existing getCurrentUser returns null on non-OK
        return new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), {
          status: 401,
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new VrchatApiClient();
    await expect(client.getProductListings({ authToken: 'expired-token' })).rejects.toBeInstanceOf(
      VrchatSessionExpiredError
    );
  });

  it('throws VrchatSessionExpiredError when listings endpoint returns 401', async () => {
    const fetchMock = mock(async (url: string) => {
      if (url.includes('/config')) {
        return new Response(JSON.stringify({ clientApiKey: 'test-key' }), {
          status: 200,
        });
      }

      if (url.includes('/auth/user')) {
        return new Response(JSON.stringify({ id: 'usr_abc', displayName: 'Creator' }), {
          status: 200,
        });
      }
      if (url.includes('/user/usr_abc/listings')) {
        return new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), {
          status: 401,
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new VrchatApiClient();
    await expect(client.getProductListings({ authToken: 'auth-token' })).rejects.toBeInstanceOf(
      VrchatSessionExpiredError
    );
  });

  it('returns empty array when user has no store listings', async () => {
    const fetchMock = mock(async (url: string) => {
      if (url.includes('/config')) {
        return new Response(JSON.stringify({ clientApiKey: 'test-key' }), {
          status: 200,
        });
      }

      if (url.includes('/auth/user')) {
        return new Response(JSON.stringify({ id: 'usr_empty', displayName: 'Creator' }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new VrchatApiClient();
    const listings = await client.getProductListings({ authToken: 'auth-token' });
    expect(listings).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// getOwnershipFromSession — productId collection
// ──────────────────────────────────────────────────────────────────────────────

describe('VrchatApiClient.getOwnershipFromSession — productId in ownedAvatarIds', () => {
  it('includes avatar.productId in ownedAvatarIds when the licensed avatar has one', async () => {
    const fetchMock = mock(async (url: string) => {
      if (url.includes('/config')) {
        return new Response(JSON.stringify({ clientApiKey: 'test-key' }), {
          status: 200,
        });
      }

      if (url.includes('/auth/user')) {
        expect(url).toContain('apiKey=test-key');
        return new Response(JSON.stringify({ id: 'usr_123', displayName: 'Buyer' }), {
          status: 200,
        });
      }
      if (url.includes('/avatars/licensed')) {
        expect(url).toContain('apiKey=test-key');
        return new Response(
          JSON.stringify([
            { id: 'avtr_aaa', name: 'Hyena Avatar', productId: 'prod_xxx' },
            { id: 'avtr_bbb', name: 'No Product ID Avatar' },
          ]),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new VrchatApiClient();
    const result = await client.getOwnershipFromSession({ authToken: 'auth-token' });

    expect(result).not.toBeNull();
    // Must contain both avatar IDs
    expect(result?.ownedAvatarIds).toContain('avtr_aaa');
    expect(result?.ownedAvatarIds).toContain('avtr_bbb');
    // Must also contain the productId of the avatar that has one
    expect(result?.ownedAvatarIds).toContain('prod_xxx');
    // Avatar without productId: no extra entry
    expect(result?.ownedAvatarIds).toHaveLength(3);
  });

  it('does not add undefined/null productId to ownedAvatarIds', async () => {
    const fetchMock = mock(async (url: string) => {
      if (url.includes('/config')) {
        return new Response(JSON.stringify({ clientApiKey: 'test-key' }), {
          status: 200,
        });
      }

      if (url.includes('/auth/user')) {
        return new Response(JSON.stringify({ id: 'usr_123', displayName: 'Buyer' }), {
          status: 200,
        });
      }
      if (url.includes('/avatars/licensed')) {
        return new Response(JSON.stringify([{ id: 'avtr_ccc', name: 'Plain Avatar' }]), {
          status: 200,
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new VrchatApiClient();
    const result = await client.getOwnershipFromSession({ authToken: 'auth-token' });

    expect(result).not.toBeNull();
    if (!result) {
      throw new Error('Expected VRChat ownership result to be present.');
    }

    expect(result.ownedAvatarIds).toHaveLength(1);
    expect(result.ownedAvatarIds).toContain('avtr_ccc');
  });
});
