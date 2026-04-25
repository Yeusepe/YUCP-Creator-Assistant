import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  RoleSelectMenuInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';

// Mock internalRpc BEFORE importing the command (bun:test hoists mock.module)
const mockListProducts = mock(() =>
  Promise.resolve({
    products: [] as Array<{
      id: string;
      name: string;
      collaboratorName?: string;
      productUrl?: string;
    }>,
  })
);
const mockListTiers = mock(() =>
  Promise.resolve({
    tiers: [] as Array<{
      active: boolean;
      amountCents?: number;
      currency?: string;
      description?: string;
      id: string;
      name: string;
      productId: string;
    }>,
  })
);
const mockCreateDiscordRoleSetupSessionToken = mock(() =>
  Promise.resolve<string | undefined>(undefined)
);
const mockGetDiscordRoleSetupResult = mock(() => Promise.resolve({ completed: false }));

mock.module('../../src/lib/internalRpc', () => ({
  listProviderProducts: mockListProducts,
  listProviderTiers: mockListTiers,
  createDiscordRoleSetupSessionToken: mockCreateDiscordRoleSetupSessionToken,
  getDiscordRoleSetupResult: mockGetDiscordRoleSetupResult,
  resolveVrchatAvatarName: mock(() => Promise.resolve({ name: undefined })),
  upsertProductCredential: mock(() => Promise.resolve({ success: true, error: undefined })),
}));

// Mock posthog so track() is a no-op
mock.module('../../src/lib/posthog', () => ({
  track: mock(() => {}),
}));

mock.module('../../../../convex/_generated/api', () => ({
  api: {
    providerConnections: {
      getConnectionStatus: 'providerConnections:getConnectionStatus',
    },
    role_rules: {
      getByGuildWithProductNames: 'role_rules:getByGuildWithProductNames',
      addProductFromDiscordRole: 'role_rules:addProductFromDiscordRole',
      addCatalogProduct: 'role_rules:addCatalogProduct',
      addProductForProvider: 'role_rules:addProductForProvider',
      createRoleRule: 'role_rules:createRoleRule',
      getByTenant: 'role_rules:getByTenant',
      deleteRoleRule: 'role_rules:deleteRoleRule',
    },
    catalogTiers: {
      upsertCatalogTier: 'catalogTiers:upsertCatalogTier',
    },
    creatorProfiles: {
      getCreatorProfile: 'creatorProfiles:getCreatorProfile',
      updateCreatorPolicy: 'creatorProfiles:updateCreatorPolicy',
    },
  },
}));

// Mock @yucp/providers so resolvePayhipProduct and resolveGumroadProduct don't make real HTTP calls
const mockResolvePayhipProduct = mock((_permalink: string) =>
  Promise.resolve({ id: _permalink, name: 'This is a test' })
);

mock.module('@yucp/providers', () => ({
  PROVIDER_META: {
    gumroad: {
      label: 'Gumroad',
      emojiKey: 'Gumorad',
      supportsLicenseVerify: true,
      supportsOAuth: true,
    },
    jinxxy: {
      label: 'Jinxxy',
      emojiKey: 'Jinxxy',
      supportsLicenseVerify: true,
      supportsOAuth: false,
    },
    lemonsqueezy: {
      label: 'Lemon Squeezy',
      emojiKey: 'LemonSqueezy',
      supportsLicenseVerify: true,
      supportsOAuth: false,
    },
    payhip: {
      label: 'Payhip',
      emojiKey: 'Payhip',
      supportsLicenseVerify: true,
      supportsOAuth: false,
    },
    vrchat: {
      label: 'VRChat',
      emojiKey: 'VRC',
      supportsLicenseVerify: false,
      supportsOAuth: false,
    },
    discord: {
      label: 'Discord',
      emojiKey: 'Discord',
      supportsLicenseVerify: false,
      supportsOAuth: true,
    },
    manual: {
      label: 'Manual',
      emojiKey: 'PersonKey',
      supportsLicenseVerify: false,
      supportsOAuth: false,
    },
  },
  providerLabel: (provider: string) =>
    (
      ({
        gumroad: 'Gumroad',
        jinxxy: 'Jinxxy',
        lemonsqueezy: 'Lemon Squeezy',
        payhip: 'Payhip',
        vrchat: 'VRChat',
        discord: 'Discord',
        manual: 'Manual',
      }) as const
    )[
      provider as 'gumroad' | 'jinxxy' | 'lemonsqueezy' | 'payhip' | 'vrchat' | 'discord' | 'manual'
    ] ?? provider,
  resolvePayhipProduct: mockResolvePayhipProduct,
  resolveGumroadProduct: mock((urlOrSlug: string) =>
    Promise.resolve({ id: urlOrSlug, name: 'Gumroad Product' })
  ),
}));

import {
  handleProductAddInteractive,
  handleProductCancelAdd,
  handleProductCatalogSelect,
  handleProductConfirmAdd,
  handleProductDiscordRoleDone,
  handleProductFinishTierMappings,
  handleProductList,
  handleProductPayhipModal,
  handleProductRoleSelect,
  handleProductTierSelect,
  handleProductTypeSelect,
} from '../../src/commands/product';
import type { MockFn } from '../helpers/mockInteraction';
import {
  extractAllCustomIds,
  mockButton,
  mockModalSubmit,
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
  patreon: true,
  payhip: true,
  vrchat: true,
});

/** Minimal convex mock for handleProductTypeSelect: returns empty guild product list. */
const TYPE_SELECT_CONVEX = {
  query: mock(() => Promise.resolve([])),
  mutation: mock(() => Promise.resolve(undefined)),
  action: mock(() => Promise.resolve(undefined)),
} as unknown as import('convex/browser').ConvexHttpClient;

beforeEach(() => {
  mockListProducts.mockReset();
  mockListProducts.mockImplementation(() =>
    Promise.resolve({
      products: [],
    })
  );
  mockListTiers.mockReset();
  mockListTiers.mockImplementation(() =>
    Promise.resolve({
      tiers: [],
    })
  );
});

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
    // discord provider itself is handled only as discord_role, not as a raw entry
    expect(optionValues).not.toContain('discord');
    // Active creator-connected membership provider
    expect(optionValues).toContain('patreon');
    // Planned/manual providers must not appear
    expect(optionValues).not.toContain('manual');
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

  it('given tiered catalog provider product selected, shows tier selection before role selection', async () => {
    const slashInteraction = mockSlashCommand({
      userId: 'user_prod_tier',
      guildId: 'guild_product_test',
      commandName: 'creator-admin',
      subcommandGroup: 'product',
      subcommand: 'add',
      isAdmin: true,
    });

    await handleProductAddInteractive(
      slashInteraction as unknown as ChatInputCommandInteraction,
      {
        authUserId: 'auth_product_tier',
        guildLinkId: 'link_id_1' as ProductCtx['guildLinkId'],
        guildId: 'guild_product_test',
      },
      ALL_CONNECTED,
      TEST_API_SECRET
    );

    const typeSelect = mockStringSelect({
      userId: 'user_prod_tier',
      guildId: 'guild_product_test',
      customId: 'creator_product:type_select:auth_product_tier',
      values: ['lemonsqueezy'],
    });
    mockListProducts.mockResolvedValueOnce({
      products: [{ id: 'prod_1', name: 'Main Product' }],
    });
    await handleProductTypeSelect(
      typeSelect as unknown as StringSelectMenuInteraction,
      'auth_product_tier',
      TYPE_SELECT_CONVEX,
      TEST_API_SECRET
    );

    mockListTiers.mockResolvedValueOnce({
      tiers: [
        {
          id: 'tier_basic',
          productId: 'prod_1',
          name: 'Basic',
          active: true,
        },
        {
          id: 'tier_pro',
          productId: 'prod_1',
          name: 'Pro',
          active: true,
        },
      ],
    });

    const productSelect = mockStringSelect({
      userId: 'user_prod_tier',
      guildId: 'guild_product_test',
      customId: 'creator_product:ls_product_select:user_prod_tier:auth_product_tier',
      values: ['prod_1'],
    });

    await handleProductCatalogSelect(
      productSelect as unknown as StringSelectMenuInteraction,
      'lemonsqueezy',
      'user_prod_tier',
      'auth_product_tier'
    );

    const payload = productSelect.reply.mock.calls[0]?.[0];
    expect(payload?.content).toContain('Step 3 of 4');
    const customIds = extractAllCustomIds(productSelect);
    expect(customIds).toContain('creator_product:tier_select:user_prod_tier:auth_product_tier');
  });

  it('given a tier selected, shows role selection as step 4', async () => {
    const slashInteraction = mockSlashCommand({
      userId: 'user_prod_tier_role',
      guildId: 'guild_product_test',
      commandName: 'creator-admin',
      subcommandGroup: 'product',
      subcommand: 'add',
      isAdmin: true,
    });

    await handleProductAddInteractive(
      slashInteraction as unknown as ChatInputCommandInteraction,
      {
        authUserId: 'auth_product_tier_role',
        guildLinkId: 'link_id_1' as ProductCtx['guildLinkId'],
        guildId: 'guild_product_test',
      },
      ALL_CONNECTED,
      TEST_API_SECRET
    );

    const typeSelect = mockStringSelect({
      userId: 'user_prod_tier_role',
      guildId: 'guild_product_test',
      customId: 'creator_product:type_select:auth_product_tier_role',
      values: ['lemonsqueezy'],
    });
    mockListProducts.mockResolvedValueOnce({
      products: [{ id: 'prod_1', name: 'Main Product' }],
    });
    await handleProductTypeSelect(
      typeSelect as unknown as StringSelectMenuInteraction,
      'auth_product_tier_role',
      TYPE_SELECT_CONVEX,
      TEST_API_SECRET
    );

    mockListTiers.mockResolvedValueOnce({
      tiers: [
        {
          id: 'tier_basic',
          productId: 'prod_1',
          name: 'Basic',
          active: true,
        },
        {
          id: 'tier_pro',
          productId: 'prod_1',
          name: 'Pro',
          active: true,
        },
      ],
    });

    const productSelect = mockStringSelect({
      userId: 'user_prod_tier_role',
      guildId: 'guild_product_test',
      customId: 'creator_product:ls_product_select:user_prod_tier_role:auth_product_tier_role',
      values: ['prod_1'],
    });
    await handleProductCatalogSelect(
      productSelect as unknown as StringSelectMenuInteraction,
      'lemonsqueezy',
      'user_prod_tier_role',
      'auth_product_tier_role'
    );

    const tierSelect = mockStringSelect({
      userId: 'user_prod_tier_role',
      guildId: 'guild_product_test',
      customId: 'creator_product:tier_select:user_prod_tier_role:auth_product_tier_role',
      values: ['tier_pro'],
    });

    await handleProductTierSelect(
      tierSelect as unknown as StringSelectMenuInteraction,
      'user_prod_tier_role',
      'auth_product_tier_role'
    );

    const payload = tierSelect.reply.mock.calls[0]?.[0];
    expect(payload?.content).toContain('Step 4 of 4');
  });

  it('auto-selects a single catalog tier so the created rule stays tier-scoped', async () => {
    const convex = {
      query: mock(() => Promise.resolve([])),
      mutation: mock((ref: unknown, args: Record<string, unknown>) => {
        if (ref === 'role_rules:addCatalogProduct') {
          return Promise.resolve({
            productId: 'prod_1',
            catalogProductId: 'catalog_prod_1',
          });
        }
        if (ref === 'catalogTiers:upsertCatalogTier') {
          return Promise.resolve('catalog_tier_single');
        }
        if (ref === 'role_rules:createRoleRule') {
          return Promise.resolve({
            ruleId: `rule_${args.catalogTierId ?? 'product'}`,
          });
        }
        return Promise.resolve(undefined);
      }),
      action: mock(() => Promise.resolve(undefined)),
    } as unknown as import('convex/browser').ConvexHttpClient;

    const slashInteraction = mockSlashCommand({
      userId: 'user_prod_single_tier',
      guildId: 'guild_product_test',
      commandName: 'creator-admin',
      subcommandGroup: 'product',
      subcommand: 'add',
      isAdmin: true,
    });

    await handleProductAddInteractive(
      slashInteraction as unknown as ChatInputCommandInteraction,
      {
        authUserId: 'auth_product_single_tier',
        guildLinkId: 'link_id_1' as ProductCtx['guildLinkId'],
        guildId: 'guild_product_test',
      },
      ALL_CONNECTED,
      TEST_API_SECRET
    );

    const typeSelect = mockStringSelect({
      userId: 'user_prod_single_tier',
      guildId: 'guild_product_test',
      customId: 'creator_product:type_select:auth_product_single_tier',
      values: ['lemonsqueezy'],
    });
    mockListProducts.mockResolvedValueOnce({
      products: [{ id: 'prod_1', name: 'Main Product' }],
    });
    await handleProductTypeSelect(
      typeSelect as unknown as StringSelectMenuInteraction,
      'auth_product_single_tier',
      TYPE_SELECT_CONVEX,
      TEST_API_SECRET
    );

    mockListTiers.mockResolvedValueOnce({
      tiers: [
        {
          id: 'tier_only',
          productId: 'prod_1',
          name: 'Only Tier',
          active: true,
          amountCents: 1500,
          currency: 'USD',
        },
      ],
    });

    const productSelect = mockStringSelect({
      userId: 'user_prod_single_tier',
      guildId: 'guild_product_test',
      customId: 'creator_product:ls_product_select:user_prod_single_tier:auth_product_single_tier',
      values: ['prod_1'],
    });
    await handleProductCatalogSelect(
      productSelect as unknown as StringSelectMenuInteraction,
      'lemonsqueezy',
      'user_prod_single_tier',
      'auth_product_single_tier'
    );

    const roleSelect = mockStringSelect({
      userId: 'user_prod_single_tier',
      guildId: 'guild_product_test',
      customId: 'creator_product:role_select:user_prod_single_tier:auth_product_single_tier',
      values: ['verified_role_1'],
    });
    roleSelect.isRoleSelectMenu = () => true;
    roleSelect.guild = {
      roles: {
        cache: new Map([['verified_role_1', { position: 1 }]]),
        fetch: () => Promise.resolve({ name: 'Verified Role' }),
      },
      members: {
        me: {
          roles: {
            highest: { position: 10 },
          },
        },
      },
    } as never;
    await handleProductRoleSelect(
      roleSelect as unknown as RoleSelectMenuInteraction,
      'user_prod_single_tier',
      'auth_product_single_tier'
    );

    const confirmInteraction = mockButton({
      userId: 'user_prod_single_tier',
      guildId: 'guild_product_test',
      customId: 'creator_product:confirm_add:user_prod_single_tier:auth_product_single_tier',
    });
    await handleProductConfirmAdd(
      confirmInteraction as unknown as ButtonInteraction,
      convex,
      TEST_API_SECRET,
      'user_prod_single_tier',
      'auth_product_single_tier'
    );

    const mutationCalls = (
      convex.mutation as unknown as {
        mock: { calls: Array<[unknown, Record<string, unknown>]> };
      }
    ).mock.calls;
    const tierUpsertCall = mutationCalls.find(([ref]) => ref === 'catalogTiers:upsertCatalogTier');
    expect(tierUpsertCall?.[1]).toMatchObject({
      providerTierRef: 'tier_only',
      displayName: 'Only Tier',
    });
    const createRoleRuleCall = mutationCalls.find(([ref]) => ref === 'role_rules:createRoleRule');
    expect(createRoleRuleCall?.[1]?.catalogTierId).toBe('catalog_tier_single');
  });

  it('renders Jinxxy tier prices from cent-denominated provider amounts', async () => {
    const slashInteraction = mockSlashCommand({
      userId: 'user_prod_jinxxy_price',
      guildId: 'guild_product_test',
      commandName: 'creator-admin',
      subcommandGroup: 'product',
      subcommand: 'add',
      isAdmin: true,
    });

    await handleProductAddInteractive(
      slashInteraction as unknown as ChatInputCommandInteraction,
      {
        authUserId: 'auth_product_jinxxy_price',
        guildLinkId: 'link_id_1' as ProductCtx['guildLinkId'],
        guildId: 'guild_product_test',
      },
      ALL_CONNECTED,
      TEST_API_SECRET
    );

    const typeSelect = mockStringSelect({
      userId: 'user_prod_jinxxy_price',
      guildId: 'guild_product_test',
      customId: 'creator_product:type_select:auth_product_jinxxy_price',
      values: ['jinxxy'],
    });
    mockListProducts.mockResolvedValueOnce({
      products: [{ id: 'prod_1', name: 'Main Product' }],
    });
    await handleProductTypeSelect(
      typeSelect as unknown as StringSelectMenuInteraction,
      'auth_product_jinxxy_price',
      TYPE_SELECT_CONVEX,
      TEST_API_SECRET
    );

    mockListTiers.mockResolvedValueOnce({
      tiers: [
        {
          id: 'tier_regular',
          productId: 'prod_1',
          name: 'Regular License',
          active: true,
          amountCents: 999,
          currency: 'USD',
        },
        {
          id: 'tier_commercial',
          productId: 'prod_1',
          name: 'Commercial License',
          active: true,
          amountCents: 9999,
          currency: 'USD',
        },
      ],
    });

    const productSelect = mockStringSelect({
      userId: 'user_prod_jinxxy_price',
      guildId: 'guild_product_test',
      customId:
        'creator_product:catalog_select:jinxxy:user_prod_jinxxy_price:auth_product_jinxxy_price',
      values: ['prod_1'],
    });

    await handleProductCatalogSelect(
      productSelect as unknown as StringSelectMenuInteraction,
      'jinxxy',
      'user_prod_jinxxy_price',
      'auth_product_jinxxy_price'
    );

    const payload = productSelect.reply.mock.calls[0]?.[0];
    const tierSelectRow = payload?.components?.[0];
    expect(tierSelectRow).toBeDefined();
    const tierSelectJson = JSON.stringify(tierSelectRow.toJSON());
    expect(tierSelectJson).toContain('9.99 USD');
    expect(tierSelectJson).toContain('99.99 USD');
    expect(tierSelectJson).not.toContain('999.00 USD');
    expect(tierSelectJson).not.toContain('9999.00 USD');
  });

  it('given Patreon returns no tiers, shows an error instead of an empty tier selector', async () => {
    const slashInteraction = mockSlashCommand({
      userId: 'user_prod_patreon_empty_tiers',
      guildId: 'guild_product_test',
      commandName: 'creator-admin',
      subcommandGroup: 'product',
      subcommand: 'add',
      isAdmin: true,
    });

    await handleProductAddInteractive(
      slashInteraction as unknown as ChatInputCommandInteraction,
      {
        authUserId: 'auth_product_patreon_empty_tiers',
        guildLinkId: 'link_id_1' as ProductCtx['guildLinkId'],
        guildId: 'guild_product_test',
      },
      ALL_CONNECTED,
      TEST_API_SECRET
    );

    const typeSelect = mockStringSelect({
      userId: 'user_prod_patreon_empty_tiers',
      guildId: 'guild_product_test',
      customId: 'creator_product:type_select:auth_product_patreon_empty_tiers',
      values: ['patreon'],
    });
    mockListProducts.mockResolvedValueOnce({
      products: [
        {
          id: 'prod_1',
          name: 'Campaign Alpha',
          productUrl: 'https://www.patreon.com/join/campaign-alpha',
        },
      ],
    });
    await handleProductTypeSelect(
      typeSelect as unknown as StringSelectMenuInteraction,
      'auth_product_patreon_empty_tiers',
      TYPE_SELECT_CONVEX,
      TEST_API_SECRET
    );

    mockListTiers.mockResolvedValueOnce({
      tiers: [],
    });

    const productSelect = mockStringSelect({
      userId: 'user_prod_patreon_empty_tiers',
      guildId: 'guild_product_test',
      customId:
        'creator_product:catalog_select:patreon:user_prod_patreon_empty_tiers:auth_product_patreon_empty_tiers',
      values: ['prod_1'],
    });
    await handleProductCatalogSelect(
      productSelect as unknown as StringSelectMenuInteraction,
      'patreon',
      'user_prod_patreon_empty_tiers',
      'auth_product_patreon_empty_tiers'
    );

    const payload = productSelect.reply.mock.calls[0]?.[0];
    expect(payload?.content).toContain("Couldn't load tiers for this product right now");
    expect(payload?.content).not.toContain('Remaining tiers: **0**');
  });

  it('given multiple tier mappings, lets the creator finish early and skip remaining tiers', async () => {
    const convex = {
      query: mock((ref: unknown) => {
        if (ref === 'providerConnections:getConnectionStatus') {
          return Promise.resolve({
            lemonsqueezy: true,
            patreon: true,
          });
        }
        return Promise.resolve([]);
      }),
      mutation: mock((ref: unknown, args: Record<string, unknown>) => {
        if (ref === 'role_rules:addCatalogProduct') {
          return Promise.resolve({
            productId: 'prod_1',
            catalogProductId: 'catalog_prod_1',
          });
        }
        if (ref === 'role_rules:createRoleRule') {
          return Promise.resolve({
            ruleId: `rule_${args.catalogTierId ?? 'product'}`,
          });
        }
        if (ref === 'catalogTiers:upsertCatalogTier') {
          return Promise.resolve(`catalog_tier_${String(args.providerTierRef)}`);
        }
        return Promise.resolve(undefined);
      }),
      action: mock(() => Promise.resolve(undefined)),
    } as unknown as import('convex/browser').ConvexHttpClient;

    const slashInteraction = mockSlashCommand({
      userId: 'user_prod_multi_tier',
      guildId: 'guild_product_test',
      commandName: 'creator-admin',
      subcommandGroup: 'product',
      subcommand: 'add',
      isAdmin: true,
    });

    await handleProductAddInteractive(
      slashInteraction as unknown as ChatInputCommandInteraction,
      {
        authUserId: 'auth_product_multi_tier',
        guildLinkId: 'link_id_1' as ProductCtx['guildLinkId'],
        guildId: 'guild_product_test',
      },
      convex,
      TEST_API_SECRET
    );

    const typeSelect = mockStringSelect({
      userId: 'user_prod_multi_tier',
      guildId: 'guild_product_test',
      customId: 'creator_product:type_select:auth_product_multi_tier',
      values: ['patreon'],
    });
    mockListProducts.mockResolvedValueOnce({
      products: [
        {
          id: 'prod_1',
          name: 'Campaign Alpha',
          productUrl: 'https://www.patreon.com/join/campaign-alpha',
        },
      ],
    });
    await handleProductTypeSelect(
      typeSelect as unknown as StringSelectMenuInteraction,
      'auth_product_multi_tier',
      TYPE_SELECT_CONVEX,
      TEST_API_SECRET
    );

    mockListTiers.mockResolvedValueOnce({
      tiers: [
        { id: 'tier_basic', productId: 'prod_1', name: 'Basic', active: true },
        { id: 'tier_pro', productId: 'prod_1', name: 'Pro', active: true },
        { id: 'tier_vip', productId: 'prod_1', name: 'VIP', active: true },
      ],
    });

    const productSelect = mockStringSelect({
      userId: 'user_prod_multi_tier',
      guildId: 'guild_product_test',
      customId:
        'creator_product:catalog_select:patreon:user_prod_multi_tier:auth_product_multi_tier',
      values: ['prod_1'],
    });
    await handleProductCatalogSelect(
      productSelect as unknown as StringSelectMenuInteraction,
      'patreon',
      'user_prod_multi_tier',
      'auth_product_multi_tier'
    );

    const tierSelect = mockStringSelect({
      userId: 'user_prod_multi_tier',
      guildId: 'guild_product_test',
      customId: 'creator_product:tier_select:user_prod_multi_tier:auth_product_multi_tier',
      values: ['tier_basic'],
    });
    await handleProductTierSelect(
      tierSelect as unknown as StringSelectMenuInteraction,
      'user_prod_multi_tier',
      'auth_product_multi_tier'
    );

    const roleSelect = mockStringSelect({
      userId: 'user_prod_multi_tier',
      guildId: 'guild_product_test',
      customId: 'creator_product:role_select:user_prod_multi_tier:auth_product_multi_tier',
      values: ['verified_role_1'],
    });
    roleSelect.isRoleSelectMenu = () => true;
    roleSelect.guild = {
      roles: {
        cache: new Map([['verified_role_1', { position: 1 }]]),
        fetch: () => Promise.resolve({ name: 'Verified Role' }),
      },
      members: {
        me: {
          roles: {
            highest: { position: 10 },
          },
        },
      },
    } as never;
    await handleProductRoleSelect(
      roleSelect as unknown as RoleSelectMenuInteraction,
      'user_prod_multi_tier',
      'auth_product_multi_tier'
    );

    const confirmInteraction = mockButton({
      userId: 'user_prod_multi_tier',
      guildId: 'guild_product_test',
      customId: 'creator_product:confirm_add:user_prod_multi_tier:auth_product_multi_tier',
    });
    await handleProductConfirmAdd(
      confirmInteraction as unknown as ButtonInteraction,
      convex,
      TEST_API_SECRET,
      'user_prod_multi_tier',
      'auth_product_multi_tier'
    );

    const loopPayload = confirmInteraction.editReply.mock.calls[0]?.[0];
    expect(loopPayload?.content).toContain('Added mapping for **Campaign Alpha / Basic**');
    expect(loopPayload?.content).toContain('Remaining tiers: **2**');
    const loopCustomIds = extractAllCustomIds(confirmInteraction);
    expect(loopCustomIds).toContain(
      'creator_product:finish_tiers:user_prod_multi_tier:auth_product_multi_tier'
    );

    const finishInteraction = mockButton({
      userId: 'user_prod_multi_tier',
      guildId: 'guild_product_test',
      customId: 'creator_product:finish_tiers:user_prod_multi_tier:auth_product_multi_tier',
    });
    await handleProductFinishTierMappings(
      finishInteraction as unknown as ButtonInteraction,
      'user_prod_multi_tier',
      'auth_product_multi_tier'
    );

    const finishPayload = finishInteraction.update.mock.calls[0]?.[0];
    expect(finishPayload?.content).toContain('**Basic:** <@&verified_role_1>');
    expect(finishPayload?.content).toContain('Skipped tiers: **2**');
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

    // Now select 'gumroad', triggers listProducts
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
      'auth_product_test',
      TYPE_SELECT_CONVEX,
      TEST_API_SECRET
    );

    // editReply should report no products found
    const editReplyPayload = selectInteraction.editReply.mock.calls[0]?.[0];
    expect(editReplyPayload?.content ?? editReplyPayload).toContain('No Gumroad products found');
  });

  it('given gumroad type selected with a transient provider error, preserves retry guidance instead of the empty state', async () => {
    mockListProducts.mockImplementation(() =>
      Promise.resolve({
        products: [],
        error: 'Too many requests. Please wait a moment and try again.',
      })
    );

    const slashInteraction = mockSlashCommand({
      userId: 'user_prod_transient',
      guildId: 'guild_product_test',
      commandName: 'creator-admin',
      subcommandGroup: 'product',
      subcommand: 'add',
      isAdmin: true,
    });
    await handleProductAddInteractive(
      slashInteraction as unknown as ChatInputCommandInteraction,
      {
        authUserId: 'auth_product_transient',
        guildLinkId: 'link_id_transient' as ProductCtx['guildLinkId'],
        guildId: 'guild_product_test',
      },
      ALL_CONNECTED,
      TEST_API_SECRET
    );

    const selectInteraction = mockStringSelect({
      userId: 'user_prod_transient',
      guildId: 'guild_product_test',
      customId: 'creator_product:type_select:auth_product_transient',
      values: ['gumroad'],
    });
    selectInteraction.deferUpdate = mock(() => Promise.resolve(undefined)) as unknown as MockFn;

    await handleProductTypeSelect(
      selectInteraction as unknown as StringSelectMenuInteraction,
      'auth_product_transient',
      TYPE_SELECT_CONVEX,
      TEST_API_SECRET
    );

    const editReplyPayload = selectInteraction.editReply.mock.calls[0]?.[0];
    const content = editReplyPayload?.content ?? editReplyPayload;
    expect(content).toContain('Too many requests. Please wait a moment and try again.');
    expect(content).not.toContain('No Gumroad products found');
    expect(content).not.toContain('after reconnecting');
  });

  it('given gumroad type selected with a malformed provider payload error, falls back to a safe actionable message', async () => {
    const leakedToken = 'secret-live-1234567890';
    mockListProducts.mockImplementation(() =>
      Promise.resolve({
        products: [],
        error: `Unexpected token < in JSON while parsing access_token=${leakedToken}`,
      })
    );

    const slashInteraction = mockSlashCommand({
      userId: 'user_prod_malformed',
      guildId: 'guild_product_test',
      commandName: 'creator-admin',
      subcommandGroup: 'product',
      subcommand: 'add',
      isAdmin: true,
    });
    await handleProductAddInteractive(
      slashInteraction as unknown as ChatInputCommandInteraction,
      {
        authUserId: 'auth_product_malformed',
        guildLinkId: 'link_id_malformed' as ProductCtx['guildLinkId'],
        guildId: 'guild_product_test',
      },
      ALL_CONNECTED,
      TEST_API_SECRET
    );

    const selectInteraction = mockStringSelect({
      userId: 'user_prod_malformed',
      guildId: 'guild_product_test',
      customId: 'creator_product:type_select:auth_product_malformed',
      values: ['gumroad'],
    });
    selectInteraction.deferUpdate = mock(() => Promise.resolve(undefined)) as unknown as MockFn;

    await handleProductTypeSelect(
      selectInteraction as unknown as StringSelectMenuInteraction,
      'auth_product_malformed',
      TYPE_SELECT_CONVEX,
      TEST_API_SECRET
    );

    const editReplyPayload = selectInteraction.editReply.mock.calls[0]?.[0];
    const content = editReplyPayload?.content ?? editReplyPayload;
    expect(content).toContain("Couldn't load Gumroad products right now.");
    expect(content).toContain('try again');
    expect(content).not.toContain('No Gumroad products found');
    expect(content).not.toContain(leakedToken);
    expect(content).not.toContain('Unexpected token');
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
      'auth_product_test',
      TYPE_SELECT_CONVEX,
      TEST_API_SECRET
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
      'auth_ghost',
      TYPE_SELECT_CONVEX,
      TEST_API_SECRET
    );

    // No deferUpdate, session check happens first; update() is called with expired message
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
      'auth_product_guard_1',
      TYPE_SELECT_CONVEX,
      TEST_API_SECRET
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
      'auth_product_other',
      TYPE_SELECT_CONVEX,
      TEST_API_SECRET
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
      'auth_product_guard_3',
      TYPE_SELECT_CONVEX,
      TEST_API_SECRET
    );

    const updatePayload = replayInteraction.update.mock.calls[0]?.[0];
    expect(updatePayload?.content).toContain('Session expired');
    expect(updatePayload?.components).toEqual([]);
    expect(replayInteraction.deferUpdate.mock.calls).toHaveLength(0);
    expect(replayInteraction.editReply.mock.calls).toHaveLength(0);
    expect(replayInteraction.showModal.mock.calls).toHaveLength(0);
  });

  it('only shows connected providers, unconnected catalog/credential providers are hidden', async () => {
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

  it('shows itch.io as a catalog-only provider when connected', async () => {
    const interaction = mockSlashCommand({
      userId: 'user_prod_itch',
      guildId: 'guild_product_itch',
      commandName: 'creator-admin',
      subcommandGroup: 'product',
      subcommand: 'add',
      isAdmin: true,
    });

    await handleProductAddInteractive(
      interaction as unknown as ChatInputCommandInteraction,
      {
        authUserId: 'auth_itch',
        guildLinkId: 'link_itch' as ProductCtx['guildLinkId'],
        guildId: 'guild_product_itch',
      },
      makeMockConvex({ itchio: true }),
      TEST_API_SECRET
    );

    const payload = interaction.reply.mock.calls[0]?.[0];
    const select = payload?.components?.[0]?.components?.[0];
    const optionValues: string[] = (select?.options ?? []).map(
      (o: { data?: { value?: string }; value?: string }) => o.data?.value ?? o.value
    );

    expect(optionValues).toContain('itchio');
    expect(optionValues).not.toContain('itchio_url');
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

  it('uses the selected source server name when discord role setup cannot resolve the guild live', async () => {
    const previousApiBaseUrl = process.env.API_BASE_URL;
    process.env.API_BASE_URL = 'https://api.example.com';
    mockCreateDiscordRoleSetupSessionToken.mockImplementation(() =>
      Promise.resolve('setup_token_1')
    );
    mockGetDiscordRoleSetupResult.mockImplementation(() =>
      Promise.resolve({
        completed: true,
        sourceGuildId: '1169053833922629653',
        sourceGuildName: 'Humanify',
        sourceRoleIds: ['1169056856354852927'],
        requiredRoleMatchMode: 'any',
      })
    );

    let mutationCallCount = 0;
    const convex = {
      query: mock((...args: unknown[]) => {
        const [, callArgs] = args as [unknown, Record<string, unknown>];
        if ('guildId' in callArgs && !('subjectId' in callArgs)) {
          return Promise.resolve({
            gumroad: true,
            jinxxy: true,
            lemonsqueezy: true,
            payhip: true,
          });
        }
        return Promise.resolve({ policy: { allowedSourceGuildIds: [] } });
      }),
      mutation: mock(() => {
        mutationCallCount += 1;
        if (mutationCallCount === 1) {
          return Promise.resolve({
            productId: 'discord_role:1169053833922629653:1169056856354852927',
            ruleId: 'rule_1',
          });
        }
        return Promise.resolve({});
      }),
      action: mock(() => Promise.resolve(undefined)),
    } as unknown as import('convex/browser').ConvexHttpClient;

    try {
      const slashInteraction = mockSlashCommand({
        userId: 'user_prod_discord_name',
        guildId: 'guild_product_test',
        commandName: 'creator-admin',
        subcommandGroup: 'product',
        subcommand: 'add',
        isAdmin: true,
      });
      await handleProductAddInteractive(
        slashInteraction as unknown as ChatInputCommandInteraction,
        {
          authUserId: 'auth_product_discord_name',
          guildLinkId: 'link_discord_name' as ProductCtx['guildLinkId'],
          guildId: 'guild_product_test',
        },
        convex,
        TEST_API_SECRET
      );

      const typeSelectInteraction = mockStringSelect({
        userId: 'user_prod_discord_name',
        guildId: 'guild_product_test',
        customId: 'creator_product:type_select:auth_product_discord_name',
        values: ['discord_role'],
      });
      typeSelectInteraction.deferUpdate = mock(() =>
        Promise.resolve(undefined)
      ) as unknown as MockFn;

      await handleProductTypeSelect(
        typeSelectInteraction as unknown as StringSelectMenuInteraction,
        'auth_product_discord_name',
        convex,
        TEST_API_SECRET
      );

      const doneInteraction = mockButton({
        userId: 'user_prod_discord_name',
        guildId: 'guild_product_test',
        customId:
          'creator_product:discord_role_done:user_prod_discord_name:auth_product_discord_name',
      });
      doneInteraction.deferUpdate = mock(() => Promise.resolve(undefined)) as unknown as MockFn;

      await handleProductDiscordRoleDone(
        doneInteraction as unknown as ButtonInteraction,
        'user_prod_discord_name',
        'auth_product_discord_name'
      );

      const roleSelectInteraction = mockStringSelect({
        userId: 'user_prod_discord_name',
        guildId: 'guild_product_test',
        customId: 'creator_product:role_select:user_prod_discord_name:auth_product_discord_name',
        values: ['verified_role_1'],
      });
      roleSelectInteraction.isRoleSelectMenu = () => true;
      roleSelectInteraction.guild = {
        roles: {
          cache: new Map([['verified_role_1', { position: 1 }]]),
          fetch: () => Promise.resolve({ name: 'Flame glasses' }),
        },
        members: {
          me: {
            roles: {
              highest: { position: 10 },
            },
          },
        },
      } as never;

      await handleProductRoleSelect(
        roleSelectInteraction as unknown as RoleSelectMenuInteraction,
        'user_prod_discord_name',
        'auth_product_discord_name'
      );

      const confirmInteraction = mockButton({
        userId: 'user_prod_discord_name',
        guildId: 'guild_product_test',
        customId: 'creator_product:confirm_add:user_prod_discord_name:auth_product_discord_name',
      });
      confirmInteraction.client.guilds.fetch = mock(async () => null);

      await handleProductConfirmAdd(
        confirmInteraction as unknown as ButtonInteraction,
        convex,
        TEST_API_SECRET,
        'user_prod_discord_name',
        'auth_product_discord_name'
      );

      const mutationCalls = (
        convex.mutation as unknown as {
          mock: { calls: Array<[unknown, Record<string, unknown>]> };
        }
      ).mock.calls;
      const addDiscordRoleCall = mutationCalls.find(([, args]) => 'sourceGuildId' in args);
      expect(addDiscordRoleCall?.[1]?.sourceGuildName).toBe('Humanify');
      expect(addDiscordRoleCall?.[1]?.displayName).toBeUndefined();
    } finally {
      process.env.API_BASE_URL = previousApiBaseUrl;
      mockCreateDiscordRoleSetupSessionToken.mockImplementation(() => Promise.resolve(undefined));
      mockGetDiscordRoleSetupResult.mockImplementation(() => Promise.resolve({ completed: false }));
    }
  });

  it('shows the stored source server name in product list when a discord role rule has no friendly role display name', async () => {
    const convex = {
      query: mock(() =>
        Promise.resolve([
          {
            productId: 'discord_role:1169053833922629653:1169056856354852927',
            displayName: null,
            provider: 'discord',
            sourceGuildId: '1169053833922629653',
            sourceGuildName: 'Humanify',
            requiredRoleId: '1169056856354852927',
            verifiedRoleId: 'verified_role_1',
            enabled: true,
          },
        ])
      ),
      mutation: mock(() => Promise.resolve(undefined)),
      action: mock(() => Promise.resolve(undefined)),
    } as unknown as import('convex/browser').ConvexHttpClient;
    const interaction = mockSlashCommand({
      userId: 'user_prod_list_discord_name',
      guildId: 'guild_product_test',
      commandName: 'creator-admin',
      subcommandGroup: 'product',
      subcommand: 'list',
      isAdmin: true,
    });
    interaction.client.guilds.fetch = mock(async () => null);

    await handleProductList(
      interaction as unknown as ChatInputCommandInteraction,
      convex,
      TEST_API_SECRET,
      {
        authUserId: 'auth_product_list_discord_name',
        guildId: 'guild_product_test',
      }
    );

    const payload = interaction.editReply.mock.calls[0]?.[0];
    const embed = payload?.embeds?.[0]?.toJSON?.() ?? payload?.embeds?.[0]?.data;
    expect(embed?.description).toContain('[Discord Role] Humanify');
    expect(embed?.description).not.toContain(
      'discord_role:1169053833922629653:1169056856354852927'
    );
  });
});

describe('handleProductPayhipModal, permalink normalization', () => {
  /** Seed a product session so modal handlers can find it. */
  async function seedPayhipSession(userId: string, authUserId: string, guildId: string) {
    const slashInteraction = mockSlashCommand({
      userId,
      guildId,
      commandName: 'creator-admin',
      subcommandGroup: 'product',
      subcommand: 'add',
      isAdmin: true,
    });
    await handleProductAddInteractive(
      slashInteraction as unknown as ChatInputCommandInteraction,
      {
        authUserId,
        guildLinkId: 'link_payhip_test' as ProductCtx['guildLinkId'],
        guildId,
      },
      ALL_CONNECTED,
      TEST_API_SECRET
    );
  }

  it('accepts a raw permalink and stores it as-is', async () => {
    const userId = 'user_ph_raw';
    const authUserId = 'auth_ph_raw';
    const guildId = 'guild_ph_raw';
    await seedPayhipSession(userId, authUserId, guildId);

    const modal = mockModalSubmit({
      userId,
      guildId,
      customId: `creator_product:payhip_modal:${userId}:${authUserId}`,
      textInputValues: { permalink: 'RGsF', product_secret_key: 'secret123' },
    });

    await handleProductPayhipModal(
      modal as unknown as import('discord.js').ModalSubmitInteraction,
      userId,
      authUserId
    );

    // Should advance to step 3 (role select), NOT show an error
    expect(modal.reply.mock.calls).toHaveLength(1);
    const replyPayload = modal.reply.mock.calls[0]?.[0];
    expect(replyPayload?.content).toContain('Step 3 of 3');
  });

  it('accepts a full Payhip URL and normalizes it to the permalink', async () => {
    const userId = 'user_ph_url';
    const authUserId = 'auth_ph_url';
    const guildId = 'guild_ph_url';
    await seedPayhipSession(userId, authUserId, guildId);

    const modal = mockModalSubmit({
      userId,
      guildId,
      customId: `creator_product:payhip_modal:${userId}:${authUserId}`,
      textInputValues: {
        permalink: 'https://payhip.com/b/KZFw0',
        product_secret_key: 'secret123',
      },
    });

    await handleProductPayhipModal(
      modal as unknown as import('discord.js').ModalSubmitInteraction,
      userId,
      authUserId
    );

    // Should advance to step 3 (role select), URL was valid
    expect(modal.reply.mock.calls).toHaveLength(1);
    const replyPayload = modal.reply.mock.calls[0]?.[0];
    expect(replyPayload?.content).toContain('Step 3 of 3');
  });

  it('rejects an input that is neither a valid URL nor a permalink', async () => {
    const userId = 'user_ph_bad';
    const authUserId = 'auth_ph_bad';
    const guildId = 'guild_ph_bad';
    await seedPayhipSession(userId, authUserId, guildId);

    const modal = mockModalSubmit({
      userId,
      guildId,
      customId: `creator_product:payhip_modal:${userId}:${authUserId}`,
      textInputValues: {
        permalink: 'not a valid url or permalink !!!',
        product_secret_key: 'secret123',
      },
    });

    await handleProductPayhipModal(
      modal as unknown as import('discord.js').ModalSubmitInteraction,
      userId,
      authUserId
    );

    expect(modal.reply.mock.calls).toHaveLength(1);
    const replyPayload = modal.reply.mock.calls[0]?.[0];
    // Should show an error, not advance to step 3
    expect(replyPayload?.content).not.toContain('Step 3 of 3');
    expect(replyPayload?.content).toContain('permalink');
  });

  it('rejects an empty permalink', async () => {
    const userId = 'user_ph_empty';
    const authUserId = 'auth_ph_empty';
    const guildId = 'guild_ph_empty';
    await seedPayhipSession(userId, authUserId, guildId);

    const modal = mockModalSubmit({
      userId,
      guildId,
      customId: `creator_product:payhip_modal:${userId}:${authUserId}`,
      textInputValues: { permalink: '', product_secret_key: 'secret123' },
    });

    await handleProductPayhipModal(
      modal as unknown as import('discord.js').ModalSubmitInteraction,
      userId,
      authUserId
    );

    expect(modal.reply.mock.calls).toHaveLength(1);
    const replyPayload = modal.reply.mock.calls[0]?.[0];
    expect(replyPayload?.content).not.toContain('Step 3 of 3');
  });
});

describe('handleProductConfirmAdd, Payhip displayName', () => {
  /** Seed a full Payhip product session up to the role-select step. */
  async function seedPayhipConfirmSession(
    userId: string,
    authUserId: string,
    guildId: string,
    permalink: string,
    secretKey: string,
    roleId: string
  ) {
    type Ctx = Parameters<typeof handleProductAddInteractive>[1];
    const slashInteraction = mockSlashCommand({
      userId,
      guildId,
      commandName: 'creator-admin',
      subcommandGroup: 'product',
      subcommand: 'add',
      isAdmin: true,
    });
    await handleProductAddInteractive(
      slashInteraction as unknown as ChatInputCommandInteraction,
      { authUserId, guildLinkId: `link_${authUserId}` as Ctx['guildLinkId'], guildId },
      ALL_CONNECTED,
      TEST_API_SECRET
    );

    const typeSelectInteraction = mockStringSelect({
      userId,
      guildId,
      customId: `creator_product:type_select:${authUserId}`,
      values: ['payhip'],
    });
    typeSelectInteraction.showModal = mock(() => Promise.resolve(undefined)) as unknown as MockFn;
    await handleProductTypeSelect(
      typeSelectInteraction as unknown as StringSelectMenuInteraction,
      authUserId,
      TYPE_SELECT_CONVEX,
      TEST_API_SECRET
    );

    const modalInteraction = mockModalSubmit({
      userId,
      guildId,
      customId: `creator_product:payhip_modal:${userId}:${authUserId}`,
      textInputValues: { permalink, product_secret_key: secretKey },
    });
    await handleProductPayhipModal(
      modalInteraction as unknown as import('discord.js').ModalSubmitInteraction,
      userId,
      authUserId
    );

    const roleSelectInteraction = {
      user: { id: userId },
      guildId,
      guild: null,
      values: [roleId],
      editReply: mock(() => Promise.resolve({ id: 'mock_msg_id' })),
    } as unknown as RoleSelectMenuInteraction;
    await handleProductRoleSelect(roleSelectInteraction, userId, authUserId);
  }

  it('calls addProductForProvider with displayName fetched via iframely', async () => {
    const userId = 'user_ph_dname';
    const authUserId = 'auth_ph_dname';
    const guildId = 'guild_ph_dname';

    await seedPayhipConfirmSession(userId, authUserId, guildId, 'KZFw0', 'secret123', 'role_dname');

    let callCount = 0;
    const mutationArgs: unknown[][] = [];
    const mockConvex = {
      mutation: mock((...args: unknown[]) => {
        mutationArgs.push(args);
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ productId: 'KZFw0', catalogProductId: 'cat_ph_dname' });
        }
        return Promise.resolve({ ruleId: 'rule_ph_dname' });
      }),
      query: mock(() => Promise.resolve(undefined)),
      action: mock(() => Promise.resolve(undefined)),
    } as unknown as import('convex/browser').ConvexHttpClient;

    const confirmInteraction = mockButton({
      userId,
      guildId,
      customId: `creator_product:confirm_add:${userId}:${authUserId}`,
    });
    await handleProductConfirmAdd(
      confirmInteraction as unknown as ButtonInteraction,
      mockConvex,
      TEST_API_SECRET,
      userId,
      authUserId
    );

    expect(mutationArgs.length).toBeGreaterThanOrEqual(1);
    const addProductArgs = mutationArgs[0]?.[1] as Record<string, unknown>;
    expect(addProductArgs?.provider).toBe('payhip');
    expect(addProductArgs?.productId).toBe('KZFw0');
    expect(addProductArgs?.displayName).toBe('This is a test');
  });
});

describe('handleProductConfirmAdd, catalog product URLs', () => {
  it('uses the provider-supplied product URL when the descriptor has no URL template', async () => {
    const userId = 'user_itch_catalog';
    const authUserId = 'auth_itch_catalog';
    const guildId = 'guild_itch_catalog';

    mockListProducts.mockImplementation(() =>
      Promise.resolve({
        products: [
          {
            id: '11',
            name: 'Game One',
            productUrl: 'https://creator.itch.io/game-one',
          },
        ],
      })
    );

    const slashInteraction = mockSlashCommand({
      userId,
      guildId,
      commandName: 'creator-admin',
      subcommandGroup: 'product',
      subcommand: 'add',
      isAdmin: true,
    });
    await handleProductAddInteractive(
      slashInteraction as unknown as ChatInputCommandInteraction,
      {
        authUserId,
        guildLinkId: 'link_itch_catalog' as ProductCtx['guildLinkId'],
        guildId,
      },
      makeMockConvex({ itchio: true }),
      TEST_API_SECRET
    );

    const typeSelectInteraction = mockStringSelect({
      userId,
      guildId,
      customId: `creator_product:type_select:${authUserId}`,
      values: ['itchio'],
    });
    typeSelectInteraction.deferUpdate = mock(() => Promise.resolve(undefined)) as unknown as MockFn;
    await handleProductTypeSelect(
      typeSelectInteraction as unknown as StringSelectMenuInteraction,
      authUserId,
      TYPE_SELECT_CONVEX,
      TEST_API_SECRET
    );

    const catalogSelectInteraction = mockStringSelect({
      userId,
      guildId,
      customId: `creator_product:catalog_select:itchio:${userId}:${authUserId}`,
      values: ['11'],
    });
    await handleProductCatalogSelect(
      catalogSelectInteraction as unknown as StringSelectMenuInteraction,
      'itchio',
      userId,
      authUserId
    );

    const roleSelectInteraction = {
      user: { id: userId },
      guildId,
      guild: null,
      values: ['role_itch_catalog'],
      editReply: mock(() => Promise.resolve({ id: 'mock_msg_id' })),
    } as unknown as RoleSelectMenuInteraction;
    await handleProductRoleSelect(roleSelectInteraction, userId, authUserId);

    let callCount = 0;
    const mutationArgs: unknown[][] = [];
    const mockConvex = {
      mutation: mock((...args: unknown[]) => {
        mutationArgs.push(args);
        callCount += 1;
        if (callCount === 1) {
          return Promise.resolve({ productId: '11', catalogProductId: 'cat_itch_catalog' });
        }
        return Promise.resolve({ ruleId: 'rule_itch_catalog' });
      }),
      query: mock(() => Promise.resolve(undefined)),
      action: mock(() => Promise.resolve(undefined)),
    } as unknown as import('convex/browser').ConvexHttpClient;

    const confirmInteraction = mockButton({
      userId,
      guildId,
      customId: `creator_product:confirm_add:${userId}:${authUserId}`,
    });
    await handleProductConfirmAdd(
      confirmInteraction as unknown as ButtonInteraction,
      mockConvex,
      TEST_API_SECRET,
      userId,
      authUserId
    );

    expect(mutationArgs.length).toBeGreaterThanOrEqual(1);
    const addProductArgs = mutationArgs[0]?.[1] as Record<string, unknown>;
    expect(addProductArgs?.provider).toBe('itchio');
    expect(addProductArgs?.productId).toBe('11');
    expect(addProductArgs?.canonicalUrl).toBe('https://creator.itch.io/game-one');
  });
});
