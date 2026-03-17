import { describe, expect, it, mock } from 'bun:test';
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';

// Mock internalRpc BEFORE importing the command (bun:test hoists mock.module)
const mockListProducts = mock(() =>
  Promise.resolve({
    products: [] as Array<{ id: string; name: string; collaboratorName?: string }>,
  })
);

mock.module('../../src/lib/internalRpc', () => ({
  listProviderProducts: mockListProducts,
  createDiscordRoleSetupSessionToken: mock(() => Promise.resolve(undefined)),
  getDiscordRoleSetupResult: mock(() => Promise.resolve({ completed: false })),
  resolveVrchatAvatarName: mock(() => Promise.resolve({ name: undefined })),
  upsertProductCredential: mock(() => Promise.resolve({ success: true, error: undefined })),
}));

// Mock posthog so track() is a no-op
mock.module('../../src/lib/posthog', () => ({
  track: mock(() => {}),
}));

import {
  handleProductAddInteractive,
  handleProductCancelAdd,
  handleProductTypeSelect,
} from '../../src/commands/product';
import type { MockFn } from '../helpers/mockInteraction';
import {
  extractAllCustomIds,
  mockButton,
  mockSlashCommand,
  mockStringSelect,
} from '../helpers/mockInteraction';

type ProductCtx = Parameters<typeof handleProductAddInteractive>[1];

const BASE_CTX: ProductCtx = {
  authUserId: 'auth_product_test',
  guildLinkId: 'link_id_1' as ProductCtx['guildLinkId'],
  guildId: 'guild_product_test',
};

const TEST_API_SECRET = 'test-api-secret';

/** Mock ConvexHttpClient that returns all catalog/credential providers as connected. */
function makeMockConvex(connectionStatus: Record<string, boolean> = {}) {
  return {
    query: mock(() => Promise.resolve(connectionStatus)),
    mutation: mock(() => Promise.resolve(undefined)),
    action: mock(() => Promise.resolve(undefined)),
  } as unknown as import('convex/browser').ConvexHttpClient;
}

// Default: all providers connected (existing behaviour for tests that don't care about filtering)
const ALL_CONNECTED = makeMockConvex({
  gumroad: true,
  jinxxy: true,
  lemonsqueezy: true,
  payhip: true,
});

/** Minimal convex mock for handleProductTypeSelect: returns empty guild product list. */
const TYPE_SELECT_CONVEX = {
  query: mock(() => Promise.resolve([])),
  mutation: mock(() => Promise.resolve(undefined)),
  action: mock(() => Promise.resolve(undefined)),
} as unknown as import('convex/browser').ConvexHttpClient;

describe('product command', () => {
  it('given /product add slash command, shows provider selection menu', async () => {
    const interaction = mockSlashCommand({
      userId: 'user_prod_1',
      guildId: 'guild_product_test',
      commandName: 'creator-admin',
      subcommandGroup: 'product',
      subcommand: 'add',
      isAdmin: true,
    });

    await handleProductAddInteractive(
      interaction as unknown as ChatInputCommandInteraction,
      BASE_CTX,
      ALL_CONNECTED,
      TEST_API_SECRET
    );

    expect(interaction.reply.mock.calls.length).toBe(1);
    const payload = interaction.reply.mock.calls[0]?.[0];
    expect(payload?.content).toContain('Step 1 of 3');

    // The select menu custom ID contains the authUserId
    const customIds = extractAllCustomIds(interaction);
    const typeSelectId = customIds.find((id) => id.startsWith('creator_product:type_select:'));
    expect(typeSelectId).toBeDefined();
    expect(typeSelectId).toBe(`creator_product:type_select:${BASE_CTX.authUserId}`);

    // All active commerce/world providers + hardcoded types must appear as options.
    // Gumroad has BOTH catalog_sync and productInput → appears as TWO options.
    const select = payload?.components?.[0]?.components?.[0];
    const optionValues: string[] = (select?.options ?? []).map(
      (o: { data?: { value?: string }; value?: string }) => o.data?.value ?? o.value
    );
    // Gumroad: both catalog and URL variants
    expect(optionValues).toContain('gumroad');
    expect(optionValues).toContain('gumroad_url');
    // Other catalog-sync providers (single entry each)
    expect(optionValues).toContain('jinxxy');
    expect(optionValues).toContain('lemonsqueezy');
    // Per-product-credential provider
    expect(optionValues).toContain('payhip');
    // Manual product-input provider
    expect(optionValues).toContain('vrchat');
    // Hardcoded special types
    expect(optionValues).toContain('license');
    expect(optionValues).toContain('discord_role');
    // discord provider itself is handled only as discord_role — not as a raw entry
    expect(optionValues).not.toContain('discord');
    // Planned/manual providers must not appear
    expect(optionValues).not.toContain('manual');
    expect(optionValues).not.toContain('patreon');
  });

  it('given gumroad_url type selected, shows text input modal for URL or ID', async () => {
    // Seed a session
    const slashInteraction = mockSlashCommand({
      userId: 'user_prod_url',
      guildId: 'guild_product_test',
      commandName: 'creator-admin',
      subcommandGroup: 'product',
      subcommand: 'add',
      isAdmin: true,
    });
    await handleProductAddInteractive(
      slashInteraction as unknown as ChatInputCommandInteraction,
      {
        authUserId: 'auth_product_url',
        guildLinkId: 'link_id_url' as ProductCtx['guildLinkId'],
        guildId: 'guild_product_test',
      },
      ALL_CONNECTED,
      TEST_API_SECRET
    );

    const selectInteraction = mockStringSelect({
      userId: 'user_prod_url',
      guildId: 'guild_product_test',
      customId: 'creator_product:type_select:auth_product_url',
      values: ['gumroad_url'],
    });
    selectInteraction.showModal = mock(() => Promise.resolve(undefined)) as unknown as MockFn;

    await handleProductTypeSelect(
      selectInteraction as unknown as StringSelectMenuInteraction,
      'auth_product_url',
      TYPE_SELECT_CONVEX,
      TEST_API_SECRET
    );

    // Should show a modal (not a catalog picker)
    expect(selectInteraction.showModal.mock.calls.length).toBe(1);
    const modal = selectInteraction.showModal.mock.calls[0]?.[0];
    // Modal custom ID uses url_modal
    expect(modal?.data?.custom_id ?? modal?.customId).toContain('url_modal');
  });

  it('given gumroad type selected but no products configured, shows empty-state error', async () => {
    mockListProducts.mockImplementation(() => Promise.resolve({ products: [] }));

    // First, seed the session by calling the slash command handler
    const slashInteraction = mockSlashCommand({
      userId: 'user_prod_2',
      guildId: 'guild_product_test',
      commandName: 'creator-admin',
      subcommandGroup: 'product',
      subcommand: 'add',
      isAdmin: true,
    });
    await handleProductAddInteractive(
      slashInteraction as unknown as ChatInputCommandInteraction,
      {
        authUserId: 'auth_product_test',
        guildLinkId: 'link_id_2' as ProductCtx['guildLinkId'],
        guildId: 'guild_product_test',
      },
      ALL_CONNECTED,
      TEST_API_SECRET
    );

    // Now select 'gumroad' — triggers listProducts
    const selectInteraction = mockStringSelect({
      userId: 'user_prod_2',
      guildId: 'guild_product_test',
      customId: `creator_product:type_select:auth_product_test`,
      values: ['gumroad'],
    });
    // deferUpdate + editReply used by this handler
    selectInteraction.deferUpdate = mock(() => Promise.resolve(undefined)) as unknown as MockFn;

    await handleProductTypeSelect(
      selectInteraction as unknown as StringSelectMenuInteraction,
      'auth_product_test'
    );

    // editReply should report no products found
    const editReplyPayload = selectInteraction.editReply.mock.calls[0]?.[0];
    expect(editReplyPayload?.content ?? editReplyPayload).toContain('No Gumroad products found');
  });

  it('given gumroad type selected with products, shows catalog select menu', async () => {
    mockListProducts.mockImplementation(() =>
      Promise.resolve({
        products: [
          { id: 'prod_abc', name: 'My Gumroad Product' },
          { id: 'prod_def', name: 'Another Product' },
        ],
      })
    );

    // Seed the session
    const slashInteraction = mockSlashCommand({
      userId: 'user_prod_3',
      guildId: 'guild_product_test',
      commandName: 'creator-admin',
      subcommandGroup: 'product',
      subcommand: 'add',
      isAdmin: true,
    });
    await handleProductAddInteractive(
      slashInteraction as unknown as ChatInputCommandInteraction,
      {
        authUserId: 'auth_product_test',
        guildLinkId: 'link_id_3' as ProductCtx['guildLinkId'],
        guildId: 'guild_product_test',
      },
      ALL_CONNECTED,
      TEST_API_SECRET
    );

    const selectInteraction = mockStringSelect({
      userId: 'user_prod_3',
      guildId: 'guild_product_test',
      customId: `creator_product:type_select:auth_product_test`,
      values: ['gumroad'],
    });
    selectInteraction.deferUpdate = mock(() => Promise.resolve(undefined)) as unknown as MockFn;

    await handleProductTypeSelect(
      selectInteraction as unknown as StringSelectMenuInteraction,
      'auth_product_test'
    );

    // Should show catalog select menu (editReply with components)
    const editReplyPayload = selectInteraction.editReply.mock.calls[0]?.[0];
    expect(editReplyPayload).toBeDefined();

    // The catalog select custom ID for gumroad uses the generic pattern
    const customIds = extractAllCustomIds(selectInteraction);
    const catalogSelectId = customIds.find(
      (id) =>
        id.startsWith('creator_product:catalog_select:gumroad:') ||
        id.startsWith('creator_product:catalog_select:')
    );
    expect(catalogSelectId).toBeDefined();
  });

  it('given handleProductTypeSelect with no session, shows session-expired message', async () => {
    // No prior session created for this userId/authUserId combo
    const selectInteraction = mockStringSelect({
      userId: 'user_prod_no_session',
      guildId: 'guild_product_test',
      customId: 'creator_product:type_select:auth_ghost',
      values: ['gumroad'],
    });
    selectInteraction.deferUpdate = mock(() => Promise.resolve(undefined)) as unknown as MockFn;

    await handleProductTypeSelect(
      selectInteraction as unknown as StringSelectMenuInteraction,
      'auth_ghost'
    );

    // No deferUpdate — session check happens first; update() is called with expired message
    const updatePayload = selectInteraction.update.mock.calls[0]?.[0];
    expect(updatePayload?.content).toContain('Session expired');
    expect(updatePayload?.components).toEqual([]);
  });

  it('rejects product type selects replayed from a different guild', async () => {
    const slashInteraction = mockSlashCommand({
      userId: 'user_prod_guard_1',
      guildId: 'guild_product_origin',
      commandName: 'creator-admin',
      subcommandGroup: 'product',
      subcommand: 'add',
      isAdmin: true,
    });
    await handleProductAddInteractive(
      slashInteraction as unknown as ChatInputCommandInteraction,
      {
        authUserId: 'auth_product_guard_1',
        guildLinkId: 'link_guard_1' as ProductCtx['guildLinkId'],
        guildId: 'guild_product_origin',
      },
      ALL_CONNECTED,
      TEST_API_SECRET
    );

    const selectInteraction = mockStringSelect({
      userId: 'user_prod_guard_1',
      guildId: 'guild_product_other',
      customId: 'creator_product:type_select:auth_product_guard_1',
      values: ['gumroad'],
    });

    await handleProductTypeSelect(
      selectInteraction as unknown as StringSelectMenuInteraction,
      'auth_product_guard_1'
    );

    const updatePayload = selectInteraction.update.mock.calls[0]?.[0];
    expect(updatePayload?.content).toContain('Session expired');
    expect(updatePayload?.components).toEqual([]);
    expect(selectInteraction.deferUpdate.mock.calls).toHaveLength(0);
    expect(selectInteraction.editReply.mock.calls).toHaveLength(0);
    expect(selectInteraction.showModal.mock.calls).toHaveLength(0);
  });

  it('rejects tampered product type selects with mismatched embedded authUserId values', async () => {
    const slashInteraction = mockSlashCommand({
      userId: 'user_prod_guard_2',
      guildId: 'guild_product_guard_2',
      commandName: 'creator-admin',
      subcommandGroup: 'product',
      subcommand: 'add',
      isAdmin: true,
    });
    await handleProductAddInteractive(
      slashInteraction as unknown as ChatInputCommandInteraction,
      {
        authUserId: 'auth_product_guard_2',
        guildLinkId: 'link_guard_2' as ProductCtx['guildLinkId'],
        guildId: 'guild_product_guard_2',
      },
      ALL_CONNECTED,
      TEST_API_SECRET
    );

    const selectInteraction = mockStringSelect({
      userId: 'user_prod_guard_2',
      guildId: 'guild_product_guard_2',
      customId: 'creator_product:type_select:auth_product_other',
      values: ['gumroad'],
    });

    await handleProductTypeSelect(
      selectInteraction as unknown as StringSelectMenuInteraction,
      'auth_product_other'
    );

    const updatePayload = selectInteraction.update.mock.calls[0]?.[0];
    expect(updatePayload?.content).toContain('Session expired');
    expect(updatePayload?.components).toEqual([]);
    expect(selectInteraction.deferUpdate.mock.calls).toHaveLength(0);
    expect(selectInteraction.editReply.mock.calls).toHaveLength(0);
    expect(selectInteraction.showModal.mock.calls).toHaveLength(0);
  });

  it('rejects replayed product type selects after the setup is cancelled', async () => {
    const slashInteraction = mockSlashCommand({
      userId: 'user_prod_guard_3',
      guildId: 'guild_product_guard_3',
      commandName: 'creator-admin',
      subcommandGroup: 'product',
      subcommand: 'add',
      isAdmin: true,
    });
    await handleProductAddInteractive(
      slashInteraction as unknown as ChatInputCommandInteraction,
      {
        authUserId: 'auth_product_guard_3',
        guildLinkId: 'link_guard_3' as ProductCtx['guildLinkId'],
        guildId: 'guild_product_guard_3',
      },
      ALL_CONNECTED,
      TEST_API_SECRET
    );

    const cancelInteraction = mockButton({
      userId: 'user_prod_guard_3',
      guildId: 'guild_product_guard_3',
      customId: 'creator_product:cancel_add:auth_product_guard_3',
    });
    await handleProductCancelAdd(
      cancelInteraction as unknown as ButtonInteraction,
      'user_prod_guard_3',
      'auth_product_guard_3'
    );

    const replayInteraction = mockStringSelect({
      userId: 'user_prod_guard_3',
      guildId: 'guild_product_guard_3',
      customId: 'creator_product:type_select:auth_product_guard_3',
      values: ['gumroad'],
    });

    await handleProductTypeSelect(
      replayInteraction as unknown as StringSelectMenuInteraction,
      'auth_product_guard_3'
    );

    const updatePayload = replayInteraction.update.mock.calls[0]?.[0];
    expect(updatePayload?.content).toContain('Session expired');
    expect(updatePayload?.components).toEqual([]);
    expect(replayInteraction.deferUpdate.mock.calls).toHaveLength(0);
    expect(replayInteraction.editReply.mock.calls).toHaveLength(0);
    expect(replayInteraction.showModal.mock.calls).toHaveLength(0);
  });

  it('only shows connected providers — unconnected catalog/credential providers are hidden', async () => {
    // Only gumroad is connected; jinxxy, lemonsqueezy, payhip are not.
    const partialConvex = makeMockConvex({ gumroad: true });
    const interaction = mockSlashCommand({
      userId: 'user_prod_partial',
      guildId: 'guild_product_partial',
      commandName: 'creator-admin',
      subcommandGroup: 'product',
      subcommand: 'add',
      isAdmin: true,
    });

    await handleProductAddInteractive(
      interaction as unknown as ChatInputCommandInteraction,
      {
        authUserId: 'auth_partial',
        guildLinkId: 'link_partial' as ProductCtx['guildLinkId'],
        guildId: 'guild_product_partial',
      },
      partialConvex,
      TEST_API_SECRET
    );

    const payload = interaction.reply.mock.calls[0]?.[0];
    const select = payload?.components?.[0]?.components?.[0];
    const optionValues: string[] = (select?.options ?? []).map(
      (o: { data?: { value?: string }; value?: string }) => o.data?.value ?? o.value
    );

    // Gumroad is connected → both catalog and URL variants appear
    expect(optionValues).toContain('gumroad');
    expect(optionValues).toContain('gumroad_url');
    // Not connected → must NOT appear
    expect(optionValues).not.toContain('jinxxy');
    expect(optionValues).not.toContain('lemonsqueezy');
    expect(optionValues).not.toContain('payhip');
    // VRChat (productInput-only) always appears regardless of connections
    expect(optionValues).toContain('vrchat');
    // Hardcoded types always appear
    expect(optionValues).toContain('license');
    expect(optionValues).toContain('discord_role');
  });

  it('shows no commerce providers when none are connected, but still shows VRChat/license/discord_role', async () => {
    const noneConvex = makeMockConvex({});
    const interaction = mockSlashCommand({
      userId: 'user_prod_none',
      guildId: 'guild_product_none',
      commandName: 'creator-admin',
      subcommandGroup: 'product',
      subcommand: 'add',
      isAdmin: true,
    });

    await handleProductAddInteractive(
      interaction as unknown as ChatInputCommandInteraction,
      {
        authUserId: 'auth_none',
        guildLinkId: 'link_none' as ProductCtx['guildLinkId'],
        guildId: 'guild_product_none',
      },
      noneConvex,
      TEST_API_SECRET
    );

    const payload = interaction.reply.mock.calls[0]?.[0];
    const select = payload?.components?.[0]?.components?.[0];
    const optionValues: string[] = (select?.options ?? []).map(
      (o: { data?: { value?: string }; value?: string }) => o.data?.value ?? o.value
    );

    expect(optionValues).not.toContain('gumroad');
    expect(optionValues).not.toContain('gumroad_url');
    expect(optionValues).not.toContain('jinxxy');
    expect(optionValues).not.toContain('lemonsqueezy');
    expect(optionValues).not.toContain('payhip');
    // These must always be present
    expect(optionValues).toContain('vrchat');
    expect(optionValues).toContain('license');
    expect(optionValues).toContain('discord_role');
  });
});
