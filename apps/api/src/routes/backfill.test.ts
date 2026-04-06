import { describe, expect, it } from 'bun:test';
import { createBackfillProductHandler } from './backfill';

describe('handleBackfillProduct', () => {
  it('returns 400 when the request body shape is invalid', async () => {
    const handleBackfillProduct = createBackfillProductHandler({
      getExpectedSecret: () => 'convex-secret',
      getConvexUrl: () => 'https://convex.invalid',
      getEncryptionSecret: () => 'test-encryption-secret',
      createConvexClient: () => ({
        query: async () => null,
        mutation: async () => ({ inserted: 0, skipped: 0 }),
        action: async () => null,
      }),
      getProviderById: () => undefined,
      ingestBackfillBatch: async () => ({ inserted: 0, skipped: 0 }),
      sleep: async () => {},
    });

    const response = await handleBackfillProduct(
      new Request('http://localhost/api/internal/backfill-product', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiSecret: 'convex-secret', authUserId: 'user-1', productId: 5 }),
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        'Missing required fields: apiSecret, authUserId, productId, provider, providerProductRef',
    });
  });

  it('returns 400 when the request body is not an object', async () => {
    const handleBackfillProduct = createBackfillProductHandler({
      getExpectedSecret: () => 'convex-secret',
      getConvexUrl: () => 'https://convex.invalid',
      getEncryptionSecret: () => 'test-encryption-secret',
      createConvexClient: () => ({
        query: async () => null,
        mutation: async () => ({ inserted: 0, skipped: 0 }),
        action: async () => null,
      }),
      getProviderById: () => undefined,
      ingestBackfillBatch: async () => ({ inserted: 0, skipped: 0 }),
      sleep: async () => {},
    });

    const response = await handleBackfillProduct(
      new Request('http://localhost/api/internal/backfill-product', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'null',
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        'Missing required fields: apiSecret, authUserId, productId, provider, providerProductRef',
    });
  });

  it('returns 400 when the request body is invalid JSON', async () => {
    const handleBackfillProduct = createBackfillProductHandler({
      getExpectedSecret: () => 'convex-secret',
      getConvexUrl: () => 'https://convex.invalid',
      getEncryptionSecret: () => 'test-encryption-secret',
      createConvexClient: () => ({
        query: async () => null,
        mutation: async () => ({ inserted: 0, skipped: 0 }),
        action: async () => null,
      }),
      getProviderById: () => undefined,
      ingestBackfillBatch: async () => ({ inserted: 0, skipped: 0 }),
      sleep: async () => {},
    });

    const response = await handleBackfillProduct(
      new Request('http://localhost/api/internal/backfill-product', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid JSON' });
  });

  it('returns 400 when the provider does not support backfill', async () => {
    const handleBackfillProduct = createBackfillProductHandler({
      getExpectedSecret: () => 'convex-secret',
      getConvexUrl: () => 'https://convex.invalid',
      getEncryptionSecret: () => 'test-encryption-secret',
      createConvexClient: () => ({
        query: async () => null,
        mutation: async () => ({ inserted: 0, skipped: 0 }),
        action: async () => null,
      }),
      getProviderById: () => undefined,
      ingestBackfillBatch: async () => ({ inserted: 0, skipped: 0 }),
      sleep: async () => {},
    });

    const response = await handleBackfillProduct(
      new Request('http://localhost/api/internal/backfill-product', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiSecret: 'convex-secret',
          authUserId: 'user-1',
          productId: 'product-1',
          provider: 'unknown',
          providerProductRef: 'provider-product-1',
        }),
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Provider "unknown" does not support backfill',
    });
  });

  it('returns 404 when provider credentials are missing', async () => {
    const handleBackfillProduct = createBackfillProductHandler({
      getExpectedSecret: () => 'convex-secret',
      getConvexUrl: () => 'https://convex.invalid',
      getEncryptionSecret: () => 'test-encryption-secret',
      createConvexClient: () => ({
        query: async () => null,
        mutation: async () => ({ inserted: 0, skipped: 0 }),
        action: async () => null,
      }),
      getProviderById: () =>
        ({
          id: 'gumroad',
          purposes: { credential: 'gumroad-oauth-access-token' },
          needsCredential: true,
          getCredential: async () => null,
          fetchProducts: async () => [],
          backfill: {
            pageDelayMs: 0,
            fetchPage: async () => ({ facts: [], nextCursor: null }),
          },
        }) as never,
      ingestBackfillBatch: async () => ({ inserted: 0, skipped: 0 }),
      sleep: async () => {},
    });

    const response = await handleBackfillProduct(
      new Request('http://localhost/api/internal/backfill-product', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiSecret: 'convex-secret',
          authUserId: 'user-1',
          productId: 'product-1',
          provider: 'gumroad',
          providerProductRef: 'provider-product-1',
        }),
      })
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'gumroad credentials not found for user',
    });
  });

  it('delegates paginated orchestration to the application service', async () => {
    const ingestedBatches: unknown[] = [];
    const handleBackfillProduct = createBackfillProductHandler({
      getExpectedSecret: () => 'convex-secret',
      getConvexUrl: () => 'https://convex.invalid',
      getEncryptionSecret: () => 'test-encryption-secret',
      createConvexClient: () => ({
        query: async () => null,
        mutation: async (_ref: unknown, args: unknown) => {
          ingestedBatches.push(args);
          return {
            inserted: ((args as { purchases: unknown[] }).purchases ?? []).length,
            skipped: 0,
          };
        },
        action: async () => null,
      }),
      getProviderById: () =>
        ({
          id: 'gumroad',
          purposes: { credential: 'gumroad-oauth-access-token' },
          needsCredential: true,
          getCredential: async () => 'credential',
          fetchProducts: async () => [],
          backfill: {
            pageDelayMs: 0,
            fetchPage: async (_credential: string, _productRef: string, cursor: string | null) => {
              if (cursor === null) {
                return {
                  facts: [
                    {
                      authUserId: '',
                      provider: 'gumroad',
                      externalOrderId: 'order-1',
                      providerProductId: 'provider-product-1',
                      paymentStatus: 'paid',
                      lifecycleStatus: 'active' as const,
                      purchasedAt: 1,
                    },
                  ],
                  nextCursor: 'cursor-2',
                };
              }

              return {
                facts: [
                  {
                    authUserId: '',
                    provider: 'gumroad',
                    externalOrderId: 'order-2',
                    providerProductId: 'provider-product-1',
                    paymentStatus: 'paid',
                    lifecycleStatus: 'active' as const,
                    purchasedAt: 2,
                  },
                ],
                nextCursor: null,
              };
            },
          },
        }) as never,
      ingestBackfillBatch: async (_convex, input) => {
        ingestedBatches.push(input);
        return { inserted: input.purchases.length, skipped: 0 };
      },
      sleep: async () => {},
    });

    const response = await handleBackfillProduct(
      new Request('http://localhost/api/internal/backfill-product', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiSecret: 'convex-secret',
          authUserId: 'user-1',
          productId: 'product-1',
          provider: 'gumroad',
          providerProductRef: 'provider-product-1',
        }),
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      inserted: 2,
      skipped: 0,
    });
    expect(ingestedBatches).toHaveLength(2);
    expect(ingestedBatches[0]).toMatchObject({
      authUserId: 'user-1',
      provider: 'gumroad',
      purchases: [{ authUserId: 'user-1', externalOrderId: 'order-1' }],
    });
  });
});
