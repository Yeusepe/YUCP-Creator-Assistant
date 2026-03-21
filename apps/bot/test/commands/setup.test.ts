import { describe, expect, it, mock } from 'bun:test';

const createConnectTokenMock = mock(() => Promise.resolve('connect-token-123'));
const getApiUrlsMock = mock(() => ({
  apiPublic: 'https://api.example.com',
  webPublic: 'https://app.example.com',
}));
const trackMock = mock(() => {});

mock.module('../../src/lib/internalRpc', () => ({
  createConnectToken: createConnectTokenMock,
  createSetupSessionToken: mock(() => Promise.resolve('setup-token-123')),
}));

mock.module('../../src/lib/apiUrls', () => ({
  getApiUrls: getApiUrlsMock,
}));

mock.module('../../src/lib/posthog', () => ({
  track: trackMock,
}));

import type { ChatInputCommandInteraction } from 'discord.js';
import { runSetupStartUnconfigured } from '../../src/commands/setup';

function createInteraction() {
  return {
    user: {
      id: 'discord-user-123',
    },
    deferReply: mock(async () => {}),
    editReply: mock(async () => {}),
  };
}

describe('setup command', () => {
  it('links unconfigured guild setup through the connect bootstrap route', async () => {
    const interaction = createInteraction();

    await runSetupStartUnconfigured(
      interaction as unknown as ChatInputCommandInteraction,
      '1458860898234929315'
    );

    const [firstCall] = interaction.editReply.mock.calls;
    expect(firstCall).toBeDefined();

    const [rawPayload] = firstCall as unknown as [unknown];
    const payload = rawPayload as {
      components?: Array<{
        components?: Array<{
          data?: {
            url?: string;
          };
        }>;
      }>;
    };

    expect(payload.components?.[0]?.components?.[0]?.data?.url).toBe(
      'https://app.example.com/dashboard?guild_id=1458860898234929315#token=connect-token-123'
    );
  });
});
