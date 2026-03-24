import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { ConvexHttpClient } from 'convex/browser';
import type { ChatInputCommandInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import { CREATOR_USER_COMMAND } from '../../src/commands';
import { handleInteraction } from '../../src/handlers/interactions';
import { getAllButtons, mockSlashCommand } from '../helpers/mockInteraction';

const ORIGINAL_FRONTEND_URL = process.env.FRONTEND_URL;
const ORIGINAL_VERIFY_BASE_URL = process.env.VERIFY_BASE_URL;
const ORIGINAL_API_BASE_URL = process.env.API_BASE_URL;

type LinkButton = {
  data?: {
    label?: string;
    url?: string;
  };
};

function makeConvex(): ConvexHttpClient {
  return {
    query: mock(async () => {
      throw new Error('The account command should not require any guild lookup');
    }),
    mutation: mock(async () => ({})),
  } as unknown as ConvexHttpClient;
}

afterEach(() => {
  process.env.FRONTEND_URL = ORIGINAL_FRONTEND_URL;
  process.env.VERIFY_BASE_URL = ORIGINAL_VERIFY_BASE_URL;
  process.env.API_BASE_URL = ORIGINAL_API_BASE_URL;
});

describe('account command', () => {
  it('registers /creator account as a user-facing subcommand', () => {
    const creator = CREATOR_USER_COMMAND.toJSON();
    const accountOption = creator.options?.find((option) => option.name === 'account');

    expect(accountOption).toBeDefined();
    expect(accountOption?.description).toMatch(/account/i);
  });

  it('opens the account portal without requiring guild context', async () => {
    process.env.FRONTEND_URL = 'https://creators.example.com';
    delete process.env.VERIFY_BASE_URL;
    delete process.env.API_BASE_URL;

    const convex = makeConvex();
    const interaction = mockSlashCommand({
      commandName: 'creator',
      guildId: null,
      subcommand: 'account',
    });

    await handleInteraction(interaction as unknown as ChatInputCommandInteraction, {
      apiSecret: 'api-secret',
      convex,
    });

    expect(interaction.reply.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
      })
    );
    expect((convex.query as ReturnType<typeof mock>).mock.calls).toHaveLength(0);

    const buttons = getAllButtons(interaction) as LinkButton[];
    expect(
      buttons.some(
        (button) =>
          button.data?.label === 'Open My Account' &&
          button.data?.url === 'https://creators.example.com/account'
      )
    ).toBe(true);
    expect(
      buttons.some(
        (button) =>
          button.data?.label === 'Manage Connections' &&
          button.data?.url === 'https://creators.example.com/account/connections'
      )
    ).toBe(true);
  });

  it('shows a configuration error when the web portal URL is unavailable', async () => {
    delete process.env.FRONTEND_URL;
    delete process.env.VERIFY_BASE_URL;
    delete process.env.API_BASE_URL;

    const convex = makeConvex();
    const interaction = mockSlashCommand({
      commandName: 'creator',
      guildId: null,
      subcommand: 'account',
    });

    await handleInteraction(interaction as unknown as ChatInputCommandInteraction, {
      apiSecret: 'api-secret',
      convex,
    });

    expect(interaction.reply.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        content: expect.stringMatching(/creator portal.*not configured/i),
        flags: MessageFlags.Ephemeral,
      })
    );
    expect((convex.query as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });
});
