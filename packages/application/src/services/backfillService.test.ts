import { describe, expect, it } from 'bun:test';
import type { BackfillServiceOptions } from './backfillService';
import {
  BackfillCredentialsNotFoundError,
  BackfillProviderNotSupportedError,
  BackfillService,
} from './backfillService';

function createOptions(): BackfillServiceOptions {
  return {
    providers: {
      getProvider: (provider) =>
        provider === 'gumroad'
          ? {
              pageDelayMs: 250,
              getCredential: async () => 'credential',
              fetchPage: async (_credential, _productRef, cursor) => {
                if (cursor === null) {
                  return {
                    facts: [
                      {
                        authUserId: '',
                        provider: 'gumroad',
                        externalOrderId: 'order-1',
                        providerProductId: 'prod-1',
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
                      providerProductId: 'prod-1',
                      paymentStatus: 'paid',
                      lifecycleStatus: 'active' as const,
                      purchasedAt: 2,
                    },
                  ],
                  nextCursor: null,
                };
              },
            }
          : undefined,
    },
    ingestion: {
      ingestBatch: async ({ purchases }) => ({
        inserted: purchases.length,
        skipped: 0,
      }),
    },
    delay: {
      sleep: async () => {},
    },
  };
}

describe('BackfillService', () => {
  it('throws when the provider has no backfill capability', async () => {
    const service = new BackfillService(createOptions());

    await expect(
      service.backfillProduct({
        authUserId: 'user-1',
        provider: 'unknown',
        providerProductRef: 'prod-1',
        pageSize: 100,
      })
    ).rejects.toBeInstanceOf(BackfillProviderNotSupportedError);
  });

  it('throws when provider credentials are missing', async () => {
    const options: BackfillServiceOptions = {
      ...createOptions(),
      providers: {
        getProvider: () => ({
          pageDelayMs: 250,
          getCredential: async () => null,
          fetchPage: async () => ({ facts: [], nextCursor: null }),
        }),
      },
    };

    const service = new BackfillService(options);

    await expect(
      service.backfillProduct({
        authUserId: 'user-1',
        provider: 'gumroad',
        providerProductRef: 'prod-1',
        pageSize: 100,
      })
    ).rejects.toBeInstanceOf(BackfillCredentialsNotFoundError);
  });

  it('paginates provider history and ingests normalized batches', async () => {
    const ingested: Array<{ authUserId: string; provider: string; purchases: unknown[] }> = [];
    const sleeps: number[] = [];
    const options: BackfillServiceOptions = {
      ...createOptions(),
      ingestion: {
        ingestBatch: async (input) => {
          ingested.push(input);
          return { inserted: input.purchases.length, skipped: 0 };
        },
      },
      delay: {
        sleep: async (waitMs) => {
          sleeps.push(waitMs);
        },
      },
    };

    const service = new BackfillService(options);
    const result = await service.backfillProduct({
      authUserId: 'user-1',
      provider: 'gumroad',
      providerProductRef: 'prod-1',
      pageSize: 100,
    });

    expect(result).toEqual({ inserted: 2, skipped: 0 });
    expect(ingested).toHaveLength(2);
    expect(ingested[0]?.purchases[0]).toMatchObject({ authUserId: 'user-1' });
    expect(sleeps).toEqual([250]);
  });
});
