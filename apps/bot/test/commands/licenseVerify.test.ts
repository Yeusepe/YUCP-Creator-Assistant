import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ConvexHttpClient } from 'convex/browser';
import type { ModalSubmitInteraction } from 'discord.js';

type CompleteLicenseVerificationPayload = {
  authUserId: string;
  discordUserId: string;
  licenseKey: string;
  productId: string;
  provider: string;
  subjectId: string;
};

const completeLicenseVerificationMock = mock(
  async (_params: CompleteLicenseVerificationPayload) => ({
    success: true,
    entitlementIds: ['entitlement_contract_1'],
  })
);

mock.module('../../src/lib/internalRpc', () => ({
  completeLicenseVerification: completeLicenseVerificationMock,
  completeVrchatVerification: mock(async () => ({ success: true })),
  disconnectVerification: mock(async () => ({ success: true })),
  listProviderProducts: mock(async () => ({ products: [] })),
}));

const { handleLicenseKeyModal } = await import('../../src/commands/licenseVerify');

function makeConvex(): ConvexHttpClient {
  return {
    mutation: mock(async () => ({ subjectId: 'subject_contract_1' })),
  } as unknown as ConvexHttpClient;
}

function makeModalInteraction(licenseKey: string) {
  return {
    customId: 'creator_verify:lp_modal:creator_auth_1:prod_1:manual',
    fields: {
      getTextInputValue: mock(() => `  ${licenseKey}  `),
    },
    user: {
      id: 'discord_user_1',
      displayName: 'Buyer User',
      displayAvatarURL: mock(() => 'https://cdn.example.com/avatar.png'),
    },
    guildId: null,
    isFromMessage: mock(() => false),
    deferReply: mock(async () => undefined),
    deferUpdate: mock(async () => undefined),
    editReply: mock(async (payload: unknown) => ({ id: 'reply_contract_1', payload })),
    reply: mock(async () => undefined),
  };
}

describe('handleLicenseKeyModal', () => {
  const originalInternalServiceAuthSecret = process.env.INTERNAL_SERVICE_AUTH_SECRET;

  beforeEach(() => {
    completeLicenseVerificationMock.mockClear();
    process.env.INTERNAL_SERVICE_AUTH_SECRET = crypto.randomUUID();
  });

  afterEach(() => {
    if (originalInternalServiceAuthSecret === undefined) {
      delete process.env.INTERNAL_SERVICE_AUTH_SECRET;
    } else {
      process.env.INTERNAL_SERVICE_AUTH_SECRET = originalInternalServiceAuthSecret;
    }
  });

  it('sends completeLicenseVerification the exact user journey payload', async () => {
    const licenseKey = crypto.randomUUID();
    const interaction = makeModalInteraction(licenseKey);

    await handleLicenseKeyModal(
      interaction as unknown as ModalSubmitInteraction,
      makeConvex(),
      crypto.randomUUID(),
      undefined
    );

    expect(completeLicenseVerificationMock).toHaveBeenCalledTimes(1);
    expect(completeLicenseVerificationMock.mock.calls[0]?.[0]).toEqual({
      licenseKey,
      productId: 'prod_1',
      provider: 'manual',
      authUserId: 'creator_auth_1',
      subjectId: 'subject_contract_1',
      discordUserId: 'discord_user_1',
    });
    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect((interaction.editReply.mock.calls[0]?.[0] as { content?: string })?.content).toContain(
      'license verified'
    );
  });
});
