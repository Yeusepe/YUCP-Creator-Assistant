import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

const handleProviderProductsMock = mock(async () => new Response(null, { status: 200 }));
const handleProviderTiersMock = mock(async () => new Response(null, { status: 200 }));

const { listProviderProductsViaApi, listProviderTiersViaApi } = await import('./router');

describe('internal RPC catalog normalization', () => {
  beforeEach(() => {
    handleProviderProductsMock.mockReset();
    handleProviderTiersMock.mockReset();
  });

  afterAll(() => {
    mock.restore();
  });

  it('normalizes sanitized product 500 route payloads instead of throwing transport errors', async () => {
    handleProviderProductsMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ products: [], error: 'Could not load gumroad products right now.' }),
        {
          status: 500,
          headers: {
            'content-type': 'application/json',
          },
        }
      )
    );

    await expect(
      listProviderProductsViaApi(
        {
          apiBaseUrl: 'https://api.example.com',
          convexApiSecret: 'convex-secret',
        },
        {
          provider: 'gumroad',
          authUserId: 'creator-user',
        },
        handleProviderProductsMock
      )
    ).resolves.toEqual({
      products: [],
      error: 'Could not load gumroad products right now.',
    });
  });

  it('stably normalizes malformed product entries from 500 route payloads', async () => {
    handleProviderProductsMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          products: [
            {
              id: 'prod_1',
              name: 'Creator Pack',
              collaboratorName: 'Alice',
              productUrl: 'https://gumroad.com/l/prod_1',
              ignored: 'value',
            },
            null,
            {
              name: 'Missing Id',
            },
          ],
          error: 'Could not load gumroad products right now.',
          apiSecret: 'should-not-survive-normalization',
        }),
        {
          status: 500,
          headers: {
            'content-type': 'application/json',
          },
        }
      )
    );

    await expect(
      listProviderProductsViaApi(
        {
          apiBaseUrl: 'https://api.example.com',
          convexApiSecret: 'convex-secret',
        },
        {
          provider: 'gumroad',
          authUserId: 'creator-user',
        },
        handleProviderProductsMock
      )
    ).resolves.toEqual({
      products: [
        {
          id: 'prod_1',
          name: 'Creator Pack',
          collaboratorName: 'Alice',
          productUrl: 'https://gumroad.com/l/prod_1',
        },
        {
          id: undefined,
          name: undefined,
          collaboratorName: undefined,
          productUrl: undefined,
        },
        {
          id: undefined,
          name: 'Missing Id',
          collaboratorName: undefined,
          productUrl: undefined,
        },
      ],
      error: 'Could not load gumroad products right now.',
    });
  });

  it('normalizes tier amount cents into bigint for the Tempo int64 contract', async () => {
    handleProviderTiersMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tiers: [
            {
              id: 'tier_1',
              productId: 'campaign_1',
              name: 'VIP',
              description: 'Top tier',
              amountCents: 1500,
              currency: 'USD',
              active: true,
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        }
      )
    );

    await expect(
      listProviderTiersViaApi(
        {
          apiBaseUrl: 'https://api.example.com',
          convexApiSecret: 'convex-secret',
        },
        {
          provider: 'patreon',
          authUserId: 'creator-user',
          productId: 'campaign_1',
        },
        handleProviderTiersMock
      )
    ).resolves.toEqual({
      tiers: [
        {
          id: 'tier_1',
          productId: 'campaign_1',
          name: 'VIP',
          description: 'Top tier',
          amountCents: 1500n,
          currency: 'USD',
          active: true,
        },
      ],
      error: undefined,
    });
  });
});
