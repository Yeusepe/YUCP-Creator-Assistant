import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ConvexHttpClient } from 'convex/browser';
import type { ButtonInteraction } from 'discord.js';
import { handleVerifyDisconnectButton } from '../../src/commands/verify';
import { mockButton } from '../helpers/mockInteraction';

type DisconnectVerificationPayload = {
  subjectId: string;
  authUserId: string;
  buyerAccountAuthUserId?: string;
  provider: string;
};

const disconnectVerificationMock = mock(async (_params: DisconnectVerificationPayload) => ({
  success: false,
  error: 'intentional test stop',
}));

mock.module('../../src/lib/internalRpc', () => ({
  completeLicenseVerification: mock(async () => ({ success: true })),
  disconnectVerification: disconnectVerificationMock,
}));

function makeDisconnectConvex(): ConvexHttpClient {
  return {
    query: mock(async (_ref: unknown, args: Record<string, unknown>) => {
      if ('discordUserId' in args) {
        return {
          found: true,
          subject: {
            _id: 'subject_buyer_disconnect',
            authUserId: 'buyer_auth_disconnect',
          },
        };
      }

      if ('discordGuildId' in args) {
        return {
          authUserId: 'creator_auth_disconnect',
        };
      }

      throw new Error(`Unexpected query args: ${JSON.stringify(args)}`);
    }),
    mutation: mock(async () => ({})),
  } as unknown as ConvexHttpClient;
}

describe('handleVerifyDisconnectButton', () => {
  const originalInternalServiceAuthSecret = process.env.INTERNAL_SERVICE_AUTH_SECRET;

  beforeEach(() => {
    process.env.INTERNAL_SERVICE_AUTH_SECRET = 'test-internal-service-secret';
  });

  afterEach(() => {
    if (originalInternalServiceAuthSecret === undefined) {
      delete process.env.INTERNAL_SERVICE_AUTH_SECRET;
    } else {
      process.env.INTERNAL_SERVICE_AUTH_SECRET = originalInternalServiceAuthSecret;
    }
  });

  it('disconnects the displayed buyer account using the buyer account owner scope', async () => {
    disconnectVerificationMock.mockClear();
    const interaction = mockButton({
      userId: 'discord_buyer_disconnect',
      guildId: 'guild_disconnect',
    });

    await handleVerifyDisconnectButton(
      interaction as unknown as ButtonInteraction,
      makeDisconnectConvex(),
      'api-secret',
      'https://api.example.com',
      'gumroad'
    );

    expect(disconnectVerificationMock).toHaveBeenCalledTimes(1);
    expect(disconnectVerificationMock.mock.calls[0]?.[0]).toEqual({
      subjectId: 'subject_buyer_disconnect',
      authUserId: 'creator_auth_disconnect',
      buyerAccountAuthUserId: 'buyer_auth_disconnect',
      provider: 'gumroad',
    });
  });
});
