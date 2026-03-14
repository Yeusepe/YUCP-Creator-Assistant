import { beforeAll, describe, expect, it, mock } from 'bun:test';

// Mock internalRpc BEFORE importing the command (bun:test hoists mock.module)
const mockListProducts = mock(() =>
  Promise.resolve({
    products: [] as Array<{ id: string; name: string; collaboratorName?: string }>,
  })
);

mock.module('../../src/lib/internalRpc', () => ({
  listProducts: mockListProducts,
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
import type { MockInteraction } from '../helpers/mockInteraction';
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

    await handleProductAddInteractive(interaction as any, BASE_CTX);

    expect(interaction.reply.mock.calls.length).toBe(1);
    const payload = interaction.reply.mock.calls[0]?.[0] as any;
    expect(payload?.content).toContain('Step 1 of 3');

    // The select menu custom ID contains the authUserId
    const customIds = extractAllCustomIds(interaction);
    const typeSelectId = customIds.find((id) => id.startsWith('creator_product:type_select:'));
    expect(typeSelectId).toBeDefined();
    expect(typeSelectId).toBe(`creator_product:type_select:${BASE_CTX.authUserId}`);
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
    await handleProductAddInteractive(slashInteraction as any, {
      authUserId: 'auth_product_test',
      guildLinkId: 'link_id_2' as ProductCtx['guildLinkId'],
      guildId: 'guild_product_test',
    });

    // Now select 'gumroad' — triggers listProducts
    const selectInteraction = mockStringSelect({
      userId: 'user_prod_2',
      guildId: 'guild_product_test',
      customId: `creator_product:type_select:auth_product_test`,
      values: ['gumroad'],
    });
    // deferUpdate + editReply used by this handler
    selectInteraction.deferUpdate = mock(() => Promise.resolve(undefined)) as any;

    await handleProductTypeSelect(selectInteraction as any, 'auth_product_test');

    // editReply should report no products found
    const editReplyPayload = selectInteraction.editReply.mock.calls[0]?.[0] as any;
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
    await handleProductAddInteractive(slashInteraction as any, {
      authUserId: 'auth_product_test',
      guildLinkId: 'link_id_3' as ProductCtx['guildLinkId'],
      guildId: 'guild_product_test',
    });

    const selectInteraction = mockStringSelect({
      userId: 'user_prod_3',
      guildId: 'guild_product_test',
      customId: `creator_product:type_select:auth_product_test`,
      values: ['gumroad'],
    });
    selectInteraction.deferUpdate = mock(() => Promise.resolve(undefined)) as any;

    await handleProductTypeSelect(selectInteraction as any, 'auth_product_test');

    // Should show catalog select menu (editReply with components)
    const editReplyPayload = selectInteraction.editReply.mock.calls[0]?.[0] as any;
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
    selectInteraction.deferUpdate = mock(() => Promise.resolve(undefined)) as any;

    await handleProductTypeSelect(selectInteraction as any, 'auth_ghost');

    // No deferUpdate — session check happens first; update() is called with expired message
    const updatePayload = selectInteraction.update.mock.calls[0]?.[0] as any;
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
    await handleProductAddInteractive(slashInteraction as any, {
      authUserId: 'auth_product_guard_1',
      guildLinkId: 'link_guard_1' as ProductCtx['guildLinkId'],
      guildId: 'guild_product_origin',
    });

    const selectInteraction = mockStringSelect({
      userId: 'user_prod_guard_1',
      guildId: 'guild_product_other',
      customId: 'creator_product:type_select:auth_product_guard_1',
      values: ['gumroad'],
    });

    await handleProductTypeSelect(selectInteraction as any, 'auth_product_guard_1');

    const updatePayload = selectInteraction.update.mock.calls[0]?.[0] as any;
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
    await handleProductAddInteractive(slashInteraction as any, {
      authUserId: 'auth_product_guard_2',
      guildLinkId: 'link_guard_2' as ProductCtx['guildLinkId'],
      guildId: 'guild_product_guard_2',
    });

    const selectInteraction = mockStringSelect({
      userId: 'user_prod_guard_2',
      guildId: 'guild_product_guard_2',
      customId: 'creator_product:type_select:auth_product_other',
      values: ['gumroad'],
    });

    await handleProductTypeSelect(selectInteraction as any, 'auth_product_other');

    const updatePayload = selectInteraction.update.mock.calls[0]?.[0] as any;
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
    await handleProductAddInteractive(slashInteraction as any, {
      authUserId: 'auth_product_guard_3',
      guildLinkId: 'link_guard_3' as ProductCtx['guildLinkId'],
      guildId: 'guild_product_guard_3',
    });

    const cancelInteraction = mockButton({
      userId: 'user_prod_guard_3',
      guildId: 'guild_product_guard_3',
      customId: 'creator_product:cancel_add:auth_product_guard_3',
    });
    await handleProductCancelAdd(
      cancelInteraction as any,
      'user_prod_guard_3',
      'auth_product_guard_3'
    );

    const replayInteraction = mockStringSelect({
      userId: 'user_prod_guard_3',
      guildId: 'guild_product_guard_3',
      customId: 'creator_product:type_select:auth_product_guard_3',
      values: ['gumroad'],
    });

    await handleProductTypeSelect(replayInteraction as any, 'auth_product_guard_3');

    const updatePayload = replayInteraction.update.mock.calls[0]?.[0] as any;
    expect(updatePayload?.content).toContain('Session expired');
    expect(updatePayload?.components).toEqual([]);
    expect(replayInteraction.deferUpdate.mock.calls).toHaveLength(0);
    expect(replayInteraction.editReply.mock.calls).toHaveLength(0);
    expect(replayInteraction.showModal.mock.calls).toHaveLength(0);
  });
});
