import { describe, expect, it } from 'bun:test';
import type { ProviderContext, ProviderRuntimeClient } from '../../src/contracts';
import { createPatreonProviderModule, PATREON_DISPLAY_META } from '../../src/patreon/module';

function makeCtx(): ProviderContext<ProviderRuntimeClient> {
  return {
    convex: {
      query: async <_QueryRef, _Args, Result>() => null as Result,
      mutation: async <_MutationRef, _Args, Result>() => null as Result,
    },
    apiSecret: 'api-secret',
    authUserId: 'user-1',
    encryptionSecret: 'enc-secret',
  };
}

describe('createPatreonProviderModule', () => {
  it('lists creator campaigns as catalog products', async () => {
    const seenUrls: string[] = [];
    const module = createPatreonProviderModule({
      logger: console,
      async getEncryptedCredential() {
        return 'encrypted-token';
      },
      async decryptCredential() {
        return 'access-token';
      },
      async fetchImpl(input) {
        seenUrls.push(String(input));
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'campaign-1',
                type: 'campaign',
                attributes: {
                  creation_name: 'Gold Club',
                  url: 'https://www.patreon.com/goldclub',
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    await expect(module.fetchProducts('access-token', makeCtx())).resolves.toEqual([
      {
        id: 'campaign-1',
        name: 'Gold Club',
        productUrl: 'https://www.patreon.com/goldclub',
        patronCount: undefined,
      },
    ]);
    expect(seenUrls).toEqual([
      'https://www.patreon.com/api/oauth2/v2/campaigns?fields%5Bcampaign%5D=creation_name%2Csummary%2Curl%2Cpatron_count',
    ]);
    expect(module.displayMeta).toEqual(PATREON_DISPLAY_META);
  });

  it('lists campaign tiers from the included tier resources', async () => {
    const seenUrls: string[] = [];
    const module = createPatreonProviderModule({
      logger: console,
      async getEncryptedCredential() {
        return 'encrypted-token';
      },
      async decryptCredential() {
        return 'access-token';
      },
      async fetchImpl(input) {
        seenUrls.push(String(input));
        return new Response(
          JSON.stringify({
            data: {
              id: 'campaign-1',
              type: 'campaign',
            },
            included: [
              {
                id: 'tier-1',
                type: 'tier',
                attributes: {
                  title: 'Commercial License',
                  description: 'Everything in the standard tier plus commercial use.',
                  amount_cents: 1500,
                  discord_role_ids: ['1234'],
                  patron_count: 42,
                  published: true,
                  url: 'https://www.patreon.com/join/goldclub/checkout?tier=1',
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    await expect(
      module.tiers?.listProductTiers('access-token', 'campaign-1', makeCtx())
    ).resolves.toEqual([
      {
        id: 'tier-1',
        productId: 'campaign-1',
        name: 'Commercial License',
        description: 'Everything in the standard tier plus commercial use.',
        amountCents: 1500,
        currency: 'USD',
        active: true,
        metadata: {
          provider: 'patreon',
          discordRoleIds: ['1234'],
          patronCount: 42,
          url: 'https://www.patreon.com/join/goldclub/checkout?tier=1',
        },
      },
    ]);
    expect(seenUrls).toEqual([
      'https://www.patreon.com/api/oauth2/v2/campaigns/campaign-1?include=tiers&fields%5Btier%5D=title%2Cdescription%2Camount_cents%2Cdiscord_role_ids%2Cpatron_count%2Cpublished%2Curl',
    ]);
  });

  it('strips Patreon HTML markup from tier descriptions', async () => {
    const module = createPatreonProviderModule({
      logger: console,
      async getEncryptedCredential() {
        return 'encrypted-token';
      },
      async decryptCredential() {
        return 'access-token';
      },
      async fetchImpl() {
        return new Response(
          JSON.stringify({
            data: {
              id: 'campaign-1',
              type: 'campaign',
            },
            included: [
              {
                id: 'tier-1',
                type: 'tier',
                attributes: {
                  title: 'Toolkit Tier',
                  description:
                    '<h2 style="">For avatar and world creators who <strong>actually</strong> use the tools.</h2><p style=""></p>',
                  amount_cents: 1500,
                  published: true,
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    await expect(
      module.tiers?.listProductTiers('access-token', 'campaign-1', makeCtx())
    ).resolves.toEqual([
      expect.objectContaining({
        description: 'For avatar and world creators who actually use the tools.',
      }),
    ]);
  });
});
