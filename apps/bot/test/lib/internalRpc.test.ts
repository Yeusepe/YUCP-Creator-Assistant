import { describe, expect, it } from 'bun:test';

const { normalizeProviderTiers } = await import('../../src/lib/internalRpcTiers');

describe('bot internalRpc tier normalization', () => {
  it('converts bigint tier amounts into numbers for bot product flows', () => {
    expect(
      normalizeProviderTiers([
        {
          id: 'tier_1',
          productId: 'campaign_1',
          name: 'VIP',
          description: 'Top tier',
          amountCents: 1500n,
          currency: 'USD',
          active: true,
        },
      ])
    ).toEqual([
      {
        id: 'tier_1',
        productId: 'campaign_1',
        name: 'VIP',
        description: 'Top tier',
        amountCents: 1500,
        currency: 'USD',
        active: true,
      },
    ]);

    expect(normalizeProviderTiers(undefined)).toEqual([]);
  });
});
