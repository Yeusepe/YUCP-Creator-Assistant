/**
 * VRChat Provider Plugin unit tests — TDD
 *
 * Tests the VRChat ProviderPlugin:
 * - getCredential: resolves and decrypts the creator's VRChat session
 * - fetchProducts: calls getProductListings, maps to ProductRecord[], propagates CredentialExpiredError
 *
 * Note: importing from ./index which does not exist yet — these tests fail at import time
 * until the production code is created. This is intentional TDD.
 */

import { describe, expect, it, mock } from 'bun:test';
import { CredentialExpiredError } from '../types';

const apiMock = {
  providerConnections: {
    getConnectionForBackfill: 'providerConnections.getConnectionForBackfill',
  },
} as const;

mock.module('../../../../../convex/_generated/api', () => ({
  api: apiMock,
}));

const { default: vrchatProvider } = await import('./index');

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeCtx(overrides?: {
  convexResult?: unknown;
  encryptionSecret?: string;
  authUserId?: string;
}): Parameters<typeof vrchatProvider.getCredential>[0] {
  return {
    convex: {
      query: mock(async () => overrides?.convexResult ?? null),
      mutation: mock(async () => null),
    } as unknown as Parameters<typeof vrchatProvider.getCredential>[0]['convex'],
    apiSecret: 'test-api-secret-32-chars!!!!!!!!!',
    authUserId: overrides?.authUserId ?? 'auth_user_123',
    encryptionSecret: overrides?.encryptionSecret ?? 'test-encryption-secret-32-chars!!',
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// getCredential
// ──────────────────────────────────────────────────────────────────────────────

describe('vrchatProvider.getCredential', () => {
  it('returns null when there is no connection in Convex', async () => {
    const ctx = makeCtx({ convexResult: null });
    const credential = await vrchatProvider.getCredential(ctx);
    expect(credential).toBeNull();
  });

  it('returns null when connection exists but has no vrchatSessionEncrypted', async () => {
    const ctx = makeCtx({ convexResult: { credentials: {} } });
    const credential = await vrchatProvider.getCredential(ctx);
    expect(credential).toBeNull();
  });

  it('decrypts and returns the session JSON when connection has vrchatSessionEncrypted', async () => {
    // We need a real encrypted value — encrypt using the same HKDF purpose as the plugin
    // Import the encrypt function to produce a valid ciphertext
    const { encrypt } = await import('../../lib/encrypt');
    const sessionPayload = JSON.stringify({ authToken: 'auth-tok', twoFactorAuthToken: 'two-tok' });
    const encryptionSecret = 'test-encryption-secret-32-chars!!';
    // The plugin uses PURPOSES.credential = 'vrchat-creator-session'
    const encrypted = await encrypt(sessionPayload, encryptionSecret, 'vrchat-creator-session');

    const ctx = makeCtx({
      convexResult: { credentials: { vrchat_session: encrypted } },
      encryptionSecret,
    });
    const credential = await vrchatProvider.getCredential(ctx);
    expect(credential).not.toBeNull();
    if (!credential) {
      throw new Error('Expected VRChat credential to decrypt successfully.');
    }
    // The returned credential should be the decrypted session JSON
    const parsed = JSON.parse(credential) as { authToken: string; twoFactorAuthToken: string };
    expect(parsed.authToken).toBe('auth-tok');
    expect(parsed.twoFactorAuthToken).toBe('two-tok');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// fetchProducts
// ──────────────────────────────────────────────────────────────────────────────

describe('vrchatProvider.fetchProducts', () => {
  it('returns empty array when credential is null', async () => {
    const ctx = makeCtx();
    const products = await vrchatProvider.fetchProducts(null, ctx);
    expect(products).toHaveLength(0);
  });

  it('maps VRChat listings to ProductRecord[] with id and name', async () => {
    const sessionCredential = JSON.stringify({ authToken: 'auth-tok' });

    // Mock fetch to return listings from the VRChat API
    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (url.includes('/config')) {
        expect(headers.get('cookie')).toBeNull();
        expect(url).not.toContain('apiKey=');
        return new Response(JSON.stringify({ clientApiKey: 'test-key' }), {
          status: 200,
        });
      }

      // All authenticated requests must carry apiKey as URL query param
      expect(url).toContain('apiKey=test-key');
      expect(headers.get('clientApiKey')).toBeNull();

      if (url.includes('/auth/user')) {
        expect(headers.get('cookie')).toContain('auth=auth-tok');
        return new Response(JSON.stringify({ id: 'usr_creator', displayName: 'Creator' }), {
          status: 200,
        });
      }
      if (url.includes('/user/usr_creator/listings')) {
        expect(headers.get('cookie')).toContain('auth=auth-tok');
        return new Response(
          JSON.stringify([
            {
              id: 'prod_aaa',
              displayName: 'Avatar Pack',
              listingType: 'permanent',
              hasAvatar: true,
              sellerId: 'usr_creator',
            },
            {
              id: 'prod_bbb',
              displayName: 'Subscription',
              listingType: 'subscription',
              hasAvatar: true,
              sellerId: 'usr_creator',
            },
          ]),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const ctx = makeCtx();
      const products = await vrchatProvider.fetchProducts(sessionCredential, ctx);
      expect(products).toHaveLength(2);
      expect(products[0].id).toBe('prod_aaa');
      expect(products[0].name).toBe('Avatar Pack');
      expect(products[1].id).toBe('prod_bbb');
      expect(products[1].name).toBe('Subscription');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('propagates CredentialExpiredError when VrchatSessionExpiredError is thrown by client', async () => {
    const sessionCredential = JSON.stringify({ authToken: 'expired-tok' });

    // Mock fetch to return 401 (session expired)
    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async (url: string) => {
      if (url.includes('/config')) {
        return new Response(JSON.stringify({ clientApiKey: 'test-key' }), {
          status: 200,
        });
      }

      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const ctx = makeCtx();
      await expect(vrchatProvider.fetchProducts(sessionCredential, ctx)).rejects.toBeInstanceOf(
        CredentialExpiredError
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
