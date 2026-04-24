import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

const listProviderTiersMock = mock(async () => ({
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
}));

mock.module('@tempojs/client', () => ({
  BearerCredential: {
    create: () => ({
      storeCredential: mock(async () => undefined),
    }),
  },
  NoStorageStrategy: class NoStorageStrategy {},
  TempoChannel: {
    forAddress: () => ({
      getClient: () => ({
        listProviderTiers: listProviderTiersMock,
      }),
    }),
  },
}));

mock.module('@tempojs/common', () => ({
  ConsoleLogger: class ConsoleLogger {},
  TempoLogLevel: {
    Warn: 'warn',
  },
}));

mock.module('@yucp/private-rpc', () => ({
  CatalogClient: class CatalogClient {},
  CollaboratorClient: class CollaboratorClient {},
  SetupClient: class SetupClient {},
  VerificationClient: class VerificationClient {},
}));

mock.module('@yucp/shared', () => ({
  getInternalRpcSharedSecret: () => 'shared-secret',
}));

mock.module('../../src/lib/apiUrls', () => ({
  getApiUrls: () => ({
    apiInternal: 'http://127.0.0.1:8787',
    apiPublic: undefined,
  }),
}));

const { listProviderTiers } = await import('../../src/lib/internalRpc');

describe('bot internalRpc tier normalization', () => {
  beforeEach(() => {
    listProviderTiersMock.mockReset();
    listProviderTiersMock.mockResolvedValue({
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
    });
  });

  afterAll(() => {
    mock.restore();
  });

  it('converts bigint tier amounts into numbers for bot product flows', async () => {
    await expect(listProviderTiers('patreon', 'creator-user', 'campaign_1')).resolves.toEqual({
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
      error: undefined,
    });
  });
});
