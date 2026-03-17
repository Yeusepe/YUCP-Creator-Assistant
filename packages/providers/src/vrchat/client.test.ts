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

// ──────────────────────────────────────────────────────────────────────────────
// getProductListings
// ──────────────────────────────────────────────────────────────────────────────

describe('VrchatApiClient.getProductListings', () => {
  it('returns listings mapped from GET /user/{userId}/listings', async () => {
    // First call: GET /auth/user → get userId
    // Second call: GET /user/usr_abc/listings → get listings
    let callCount = 0;
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      callCount++;
      const headers = new Headers(init?.headers);
      expect(headers.get('cookie')).toContain('auth=auth-token');

      if (url.endsWith('/auth/user')) {
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

    expect(callCount).toBe(2);
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
      expect(headers.get('cookie')).toContain('auth=tok; twoFactorAuth=two');

      if (url.endsWith('/auth/user')) {
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
      if (url.endsWith('/auth/user')) {
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
      if (url.endsWith('/auth/user')) {
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
      if (url.endsWith('/auth/user')) {
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
      if (url.endsWith('/auth/user')) {
        return new Response(JSON.stringify({ id: 'usr_123', displayName: 'Buyer' }), {
          status: 200,
        });
      }
      if (url.includes('/avatars/licensed')) {
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
      if (url.endsWith('/auth/user')) {
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

    expect(result!.ownedAvatarIds).toHaveLength(1);
    expect(result!.ownedAvatarIds).toContain('avtr_ccc');
  });
});
