import { afterEach, describe, expect, it, mock } from 'bun:test';

const ingestCalls: Array<Record<string, unknown>> = [];
const productListArgs: Array<Record<string, unknown>> = [];
const productGetArgs: Array<Record<string, unknown>> = [];
let productListItems: Array<Record<string, unknown>> = [];
const productDetailsById = new Map<string, Record<string, unknown>>();
const originalPolarAccessToken = process.env.POLAR_ACCESS_TOKEN;

mock.module('@polar-sh/sdk', () => ({
  Polar: class PolarMock {
    events = {
      ingest: async (args: Record<string, unknown>) => {
        ingestCalls.push(args);
      },
    };
    products = {
      list: async (args: Record<string, unknown>) => {
        productListArgs.push(args);
        return (async function* () {
          yield { result: { items: productListItems } };
        })();
      },
      get: async (args: Record<string, unknown>) => {
        productGetArgs.push(args);
        const productId = typeof args.id === 'string' ? args.id : '';
        const product = productDetailsById.get(productId);
        if (!product) {
          throw new Error(`Unexpected product id: ${productId}`);
        }
        return product;
      },
    };
  },
}));

const { ingestUsageEvent, syncCatalog } = await import('./certificateBillingSync');

afterEach(() => {
  ingestCalls.length = 0;
  productListArgs.length = 0;
  productGetArgs.length = 0;
  productListItems = [];
  productDetailsById.clear();
  process.env.POLAR_ACCESS_TOKEN = originalPolarAccessToken;
});

describe('certificateBillingSync ingestUsageEvent', () => {
  it('uses a unique external id for each signature.recorded event', async () => {
    process.env.POLAR_ACCESS_TOKEN = 'test-polar-access-token';

    await ingestUsageEvent._handler(
      {} as never,
      {
        authUserId: 'auth-user-1',
        workspaceKey: 'creator-profile:profile-1',
        certNonce: 'cert-123',
      }
    );
    await ingestUsageEvent._handler(
      {} as never,
      {
        authUserId: 'auth-user-1',
        workspaceKey: 'creator-profile:profile-1',
        certNonce: 'cert-123',
      }
    );

    expect(ingestCalls).toHaveLength(2);

    const firstExternalId = (ingestCalls[0].events as Array<{ externalId: string }>)[0]?.externalId;
    const secondExternalId = (ingestCalls[1].events as Array<{ externalId: string }>)[0]
      ?.externalId;

    expect(firstExternalId).toContain('signature.recorded:cert-123');
    expect(secondExternalId).toContain('signature.recorded:cert-123');
    expect(firstExternalId).not.toBe('signature.recorded:cert-123');
    expect(secondExternalId).not.toBe(firstExternalId);
  });

  it('loads recurring suite products without requiring the legacy yucp_domain filter', async () => {
    process.env.POLAR_ACCESS_TOKEN = 'test-polar-access-token';
    const product = {
      id: 'prod_creator_suite_plus',
      name: 'Creator Suite+',
      description: 'Everything in one plan',
      recurringInterval: 'month',
      metadata: {},
      prices: [
        {
          id: 'price_creator_suite_plus_monthly',
          amountType: 'fixed',
        },
      ],
      benefits: [
        {
          id: 'benefit_default_limits',
          type: 'custom',
          description: 'Default limits',
          metadata: {
            device_cap: 3,
            audit_retention_days: 30,
            support_tier: 'standard',
            tier_rank: 1,
          },
        },
        {
          id: 'benefit_coupling_traceability',
          type: 'feature_flag',
          description: 'Coupling Traceability',
          metadata: {
            coupling_traceability: true,
          },
        },
      ],
    };
    productListItems = [product];
    productDetailsById.set('prod_creator_suite_plus', product);

    const runMutationCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

    const result = await syncCatalog._handler(
      {
        runMutation: async (fn: { _handler?: unknown; name?: string }, args: Record<string, unknown>) => {
          runMutationCalls.push({ name: fn.name ?? 'mutation', args });
        },
      } as never,
      {
        reason: 'test',
      }
    );

    expect(productListArgs[0]).toEqual({
      limit: 100,
    });
    expect(result).toEqual({
      synced: true,
      productCount: 1,
      benefitCount: 2,
    });
    expect(runMutationCalls).toHaveLength(1);
    expect(runMutationCalls[0]?.args.products).toHaveLength(1);
  });

  it('hydrates product details from Polar before normalizing the catalog', async () => {
    process.env.POLAR_ACCESS_TOKEN = 'test-polar-access-token';
    productListItems = [
      {
        id: 'prod_creator_studio_plus',
        name: 'Creator Studio+',
        description: 'Summary payload without benefit metadata',
        recurringInterval: 'month',
        metadata: {},
        prices: [
          {
            id: 'price_creator_studio_plus_monthly',
            amountType: 'fixed',
          },
        ],
        benefits: [
          {
            id: 'benefit_default_limits',
            type: 'feature_flag',
            description: 'Default Limits',
            metadata: {},
          },
        ],
      },
    ];
    productDetailsById.set('prod_creator_studio_plus', {
      id: 'prod_creator_studio_plus',
      name: 'Creator Studio+',
      description: 'Full product payload',
      recurringInterval: 'month',
      metadata: {},
      prices: [
        {
          id: 'price_creator_studio_plus_monthly',
          amountType: 'fixed',
        },
      ],
      benefits: [
        {
          id: 'benefit_default_limits',
          type: 'feature_flag',
          description: 'Default Limits',
          metadata: {
            device_cap: '5',
            audit_retention_days: '90',
            support_tier: 'premium',
            sign_quota_per_period: '1000',
            tier_rank: '100',
          },
        },
        {
          id: 'benefit_coupling_traceability',
          type: 'feature_flag',
          description: 'Coupling Traceability',
          metadata: {
            coupling_traceability: 'true',
          },
        },
      ],
    });

    const runMutationCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

    const result = await syncCatalog._handler(
      {
        runMutation: async (fn: { _handler?: unknown; name?: string }, args: Record<string, unknown>) => {
          runMutationCalls.push({ name: fn.name ?? 'mutation', args });
        },
      } as never,
      {
        reason: 'test',
      }
    );

    expect(result).toEqual({
      synced: true,
      productCount: 1,
      benefitCount: 2,
    });
    expect(productGetArgs).toEqual([{ id: 'prod_creator_studio_plus' }]);
    expect(runMutationCalls).toHaveLength(1);
    expect(runMutationCalls[0]?.args.products).toEqual([
      expect.objectContaining({
        productId: 'prod_creator_studio_plus',
        displayName: 'Creator Studio+',
      }),
    ]);
    expect(runMutationCalls[0]?.args.benefits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          benefitId: 'benefit_default_limits',
          deviceCap: 5,
          auditRetentionDays: 90,
          signQuotaPerPeriod: 1000,
          supportTier: 'premium',
          tierRank: 100,
        }),
        expect.objectContaining({
          benefitId: 'benefit_coupling_traceability',
          capabilityKeys: ['coupling_traceability'],
        }),
      ])
    );
  });
});
