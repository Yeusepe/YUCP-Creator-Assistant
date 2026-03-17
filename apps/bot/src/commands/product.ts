/**
 * /creator-admin product - Product-role mapping commands
 *
 * add: Interactive guided flow (type select → URL modal → role select → confirm)
 * list: List product-role mappings
 * remove: Remove a product mapping
 */

import {
  buildCatalogProductUrl,
  createLogger,
  getProviderDescriptor,
  PROVIDER_REGISTRY,
  type ProviderDescriptor,
  parseProductId,
  providerLabel,
} from '@yucp/shared';
import type { ConvexHttpClient } from 'convex/browser';
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  ModalSubmitInteraction,
  RoleSelectMenuInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { E, Emoji } from '../lib/emojis';
import {
  createDiscordRoleSetupSessionToken,
  getDiscordRoleSetupResult,
  listProviderProducts,
  resolveVrchatProductName,
  upsertProductCredential,
} from '../lib/internalRpc';
import { track } from '../lib/posthog';
import { canBotManageRole } from '../lib/roleHierarchy';
import { sanitizeUserFacingErrorMessage } from '../lib/userFacingErrors';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

// In-memory session store for multi-step product add flow
interface ProductSession {
  authUserId: string;
  guildLinkId: Id<'guild_links'>;
  guildId: string;
  /** Provider key (e.g. 'gumroad', 'jinxxy'), or 'license'/'discord_role' for special types */
  type?: string;
  urlOrId?: string;
  /** Per-product credential key (e.g. Payhip product secret key) */
  perProductCredentialKey?: string;
  sourceGuildId?: string;
  sourceRoleId?: string;
  sourceRoleIds?: string[];
  requiredRoleMatchMode?: 'any' | 'all';
  roleId?: string;
  roleIds?: string[];
  discordRoleSetupToken?: string;
  /** provider key -> (product id -> display name) for catalog-selected products */
  productNames?: Record<string, Record<string, string>>;
  /** provider key -> (product id -> source/collaborator name) */
  productSources?: Record<string, Record<string, string>>;
  removeProductIds?: string[];
  expiresAt: number;
}

const productSessions = new Map<string, ProductSession>();

// ─────────────────────────────────────────────────────────────────────────────
// DISCORD ROLE NAME RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enriches discord_role product entries with human-readable role names.
 *
 * Groups entries by sourceGuildId and issues a single `guild.roles.fetch()`
 * per unique guild rather than one request per role. Discord.js handles rate
 * limiting automatically via its internal REST bucket manager.
 *
 * Entries that already have a `displayName` (persisted at add time) are left
 * unchanged. Entries whose source guild the bot cannot access (bot not a
 * member, unknown guild) are returned as-is with `displayName` still null.
 */
async function enrichDiscordRoleNames<
  T extends {
    productId: string;
    displayName: string | null;
    provider?: string;
    sourceGuildId?: string;
    requiredRoleId?: string;
    requiredRoleIds?: string[];
    requiredRoleMatchMode?: 'any' | 'all';
  },
>(client: Client, items: T[]): Promise<T[]> {
  const toResolve = items.filter(
    (r) => r.provider === 'discord' && r.displayName === null && r.sourceGuildId
  );
  if (toResolve.length === 0) return items;

  const uniqueGuildIds = [...new Set(toResolve.map((r) => r.sourceGuildId as string))];

  // Per-guild resolved role names: guildId → Map<roleId, roleName>
  const guildRoles = new Map<string, Map<string, string>>();
  const guildNames = new Map<string, string>();

  await Promise.all(
    uniqueGuildIds.map(async (guildId) => {
      try {
        const guild =
          client.guilds.cache.get(guildId) ??
          (await client.guilds.fetch(guildId).catch(() => null));
        if (!guild) return;

        guildNames.set(guildId, guild.name);

        // Use cache if already populated (e.g. from GUILD_CREATE); otherwise fetch all roles
        // in a single API call rather than one request per role ID.
        const rolesCollection =
          guild.roles.cache.size > 0
            ? guild.roles.cache
            : await guild.roles.fetch().catch(() => null);
        if (!rolesCollection) return;

        const roleMap = new Map<string, string>();
        for (const [id, role] of rolesCollection) {
          roleMap.set(id, role.name);
        }
        guildRoles.set(guildId, roleMap);
      } catch {
        // Bot not in source guild — skip silently, raw productId will show instead
      }
    })
  );

  return items.map((item) => {
    if (item.provider !== 'discord' || item.displayName !== null || !item.sourceGuildId) {
      return item;
    }
    const roleMap = guildRoles.get(item.sourceGuildId);
    const guildName = guildNames.get(item.sourceGuildId);
    if (!roleMap) return item;

    const reqIds = item.requiredRoleIds ?? (item.requiredRoleId ? [item.requiredRoleId] : []);
    const names = reqIds
      .map((id) => roleMap.get(id))
      .filter((n): n is string => typeof n === 'string');
    if (names.length === 0) return item;

    // Show "Role A + Role B" for "all" mode, "Role A / Role B" for "any" mode
    const sep = item.requiredRoleMatchMode === 'all' ? ' + ' : ' / ';
    const displayName = guildName ? `${names.join(sep)} (${guildName})` : names.join(sep);
    return { ...item, displayName };
  });
}

function getSessionKey(userId: string, authUserId: string, guildId: string): string {
  return `${userId}:${authUserId}:${guildId}`;
}

function cleanExpiredSessions(): void {
  const now = Date.now();
  for (const [key, session] of productSessions.entries()) {
    if (now > session.expiresAt) productSessions.delete(key);
  }
}

/** Returns the Discord custom ID for the catalog product select menu.
 * Preserves legacy IDs for jinxxy/lemonsqueezy to avoid breaking existing Discord sessions.
 */
function getCatalogSelectCustomId(provider: string, userId: string, authUserId: string): string {
  if (provider === 'jinxxy') return `creator_product:jinxxy_product_select:${userId}:${authUserId}`;
  if (provider === 'lemonsqueezy')
    return `creator_product:ls_product_select:${userId}:${authUserId}`;
  return `creator_product:catalog_select:${provider}:${userId}:${authUserId}`;
}

/** Step 1: /creator-admin product add - show type select menu */
export async function handleProductAddInteractive(
  interaction: ChatInputCommandInteraction,
  ctx: { authUserId: string; guildLinkId: Id<'guild_links'>; guildId: string },
  convex: ConvexHttpClient,
  apiSecret: string
): Promise<void> {
  cleanExpiredSessions();

  const sessionKey = getSessionKey(interaction.user.id, ctx.authUserId, ctx.guildId);
  productSessions.set(sessionKey, {
    authUserId: ctx.authUserId,
    guildLinkId: ctx.guildLinkId,
    guildId: ctx.guildId,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  // Only show providers the user has actively connected in the dashboard.
  // Providers that don't require a dashboard connection (productInput-only, e.g. VRChat)
  // are always shown. license/discord_role are hardcoded below and always shown.
  const connectionStatus = await convex.query(api.providerConnections.getConnectionStatus, {
    apiSecret,
    authUserId: ctx.authUserId,
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId(`creator_product:type_select:${ctx.authUserId}`)
    .setPlaceholder('Select product type...')
    .addOptions(
      // Active commerce/world providers that have a product-add step 2.
      // Providers with BOTH catalog_sync AND productInput emit two entries:
      // one for the catalog picker (key = providerKey) and one for manual URL/ID
      // entry (key = "${providerKey}_url").
      ...(PROVIDER_REGISTRY as readonly ProviderDescriptor[])
        .filter((d) => {
          if (d.status !== 'active') return false;
          if (d.providerKey === 'manual' || d.providerKey === 'discord') return false;
          const hasCatalog = (d.capabilities as readonly string[]).includes('catalog_sync');
          const hasPerProduct = 'perProductCredential' in d;
          const hasProductInput = d.productInput != null;
          if (!hasCatalog && !hasPerProduct && !hasProductInput) return false;
          // productInput entries that don't require a connection are always shown
          // (e.g. VRChat — avatars can be added by ID before the creator connects).
          if (hasProductInput && d.productInput?.requiresConnection === false) return true;
          // All other providers require an active dashboard connection.
          return !!connectionStatus[d.providerKey];
        })
        .flatMap((d) => {
          const emoji = Emoji[d.emojiKey as keyof typeof Emoji];
          const hasCatalog = (d.capabilities as readonly string[]).includes('catalog_sync');
          const hasManual = d.productInput != null;

          if (hasCatalog && hasManual) {
            // Two entries: catalog pick + manual URL/ID
            const catalogOpt = new StringSelectMenuOptionBuilder()
              .setLabel(`${d.label} (from your store)`)
              .setDescription(d.addProductDescription)
              .setValue(d.providerKey);
            if (emoji) catalogOpt.setEmoji(emoji);

            const manualOpt = new StringSelectMenuOptionBuilder()
              .setLabel(`${d.label} (by URL or ID)`)
              .setDescription(d.productInput?.description ?? '')
              .setValue(`${d.providerKey}_url`);
            if (emoji) manualOpt.setEmoji(emoji);

            return [catalogOpt, manualOpt];
          }

          const opt = new StringSelectMenuOptionBuilder()
            .setLabel(d.label)
            .setDescription(d.addProductDescription)
            .setValue(d.providerKey);
          if (emoji) opt.setEmoji(emoji);
          return [opt];
        }),
      // Special 'license' type: manual/standalone license keys
      new StringSelectMenuOptionBuilder()
        .setLabel('License Key Only')
        .setDescription('Manually issued license key')
        .setValue('license')
        .setEmoji(Emoji.PersonKey),
      // Special 'discord_role' type: role from another server
      new StringSelectMenuOptionBuilder()
        .setLabel('Discord Role (Other Server)')
        .setDescription('User has a specific role in another server')
        .setValue('discord_role')
        .setEmoji(Emoji.Link)
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

  await interaction.reply({
    content: '**Step 1 of 3:** What type of product are you mapping?',
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

/** Step 2: Type selected - show relevant modal */
export async function handleProductTypeSelect(
  interaction: StringSelectMenuInteraction,
  authUserId: string,
  convex: ConvexHttpClient,
  apiSecret: string
): Promise<void> {
  const selectedType = interaction.values[0] as string;
  const sessionKey = getSessionKey(interaction.user.id, authUserId, interaction.guildId ?? '');
  const session = productSessions.get(sessionKey);

  if (!session || Date.now() > session.expiresAt) {
    await interaction.update({
      content: `${E.Timer} Session expired. Please run \`/creator-admin product add\` again.`,
      components: [],
    });
    return;
  }

  session.type = selectedType;

  if (selectedType === 'discord_role') {
    const { apiInternal, apiPublic } = (await import('../lib/apiUrls')).getApiUrls();
    const apiBase = apiPublic ?? apiInternal;

    if (!apiBase) {
      // Fallback: show modal if API_BASE_URL not configured
      const modal = new ModalBuilder()
        .setCustomId(`creator_product:discord_modal:${interaction.user.id}:${authUserId}`)
        .setTitle('Step 2 of 3: Discord Role Details')
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('source_guild_id')
              .setLabel('Source Server ID')
              .setPlaceholder('Right-click the server → Copy Server ID (requires Developer Mode)')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('source_role_ids')
              .setLabel('Source Role ID(s)')
              .setPlaceholder('One per line or comma-separated. e.g. 123456789012345678')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('match_mode')
              .setLabel('Match mode (any/all)')
              .setPlaceholder('any = user needs one role; all = user needs every role')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setValue('any')
          )
        );
      await interaction.showModal(modal);
      return;
    }

    // Create a setup session on the API for the web flow (use internal URL when on Zeabur)
    await interaction.deferUpdate();
    try {
      const token = await createDiscordRoleSetupSessionToken({
        authUserId,
        guildId: session.guildId,
        adminDiscordUserId: interaction.user.id,
      });
      if (!token) throw new Error('Missing setup token');
      session.discordRoleSetupToken = token;

      const setupUrl = `${apiBase}/discord-role-setup#s=${encodeURIComponent(token)}`;
      const doneButtonId = `creator_product:discord_role_done:${interaction.user.id}:${authUserId}`;

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setLabel('Open Setup Page').setStyle(ButtonStyle.Link).setURL(setupUrl),
        new ButtonBuilder()
          .setCustomId(doneButtonId)
          .setLabel("Done, I've selected it")
          .setEmoji(Emoji.Checkmark)
          .setStyle(ButtonStyle.Success)
      );

      await interaction.editReply({
        content:
          '**Step 2 of 3:** Open the setup page to pick a server and role.\n\nSign in with Discord, choose the source server, and enter the role ID. Then come back and click **Done**.',
        components: [row],
      });
    } catch (err) {
      logger.error('Failed to start Discord role setup', {
        error: err instanceof Error ? err.message : String(err),
        authUserId,
        guildId: session.guildId,
      });
      await interaction.editReply({
        content: `${E.X_} Couldn’t start setup right now. Run \`/creator-admin product add\` again in a moment.`,
        components: [],
      });
    }
    return;
  }

  const descriptor = getProviderDescriptor(selectedType);

  // Handle _url variants: e.g. 'gumroad_url' → manual text input using the base
  // provider's productInput config (same modal as non-catalog providers).
  if (selectedType.endsWith('_url')) {
    const baseKey = selectedType.slice(0, -4);
    const baseDescriptor = getProviderDescriptor(baseKey);
    const productInput = baseDescriptor?.productInput;
    if (productInput) {
      const modal = new ModalBuilder()
        .setCustomId(`creator_product:url_modal:${interaction.user.id}:${authUserId}`)
        .setTitle('Step 2 of 3: Product Details')
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('url_or_id')
              .setLabel(productInput.label)
              .setPlaceholder(productInput.placeholder ?? productInput.description)
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          )
        );
      await interaction.showModal(modal);
      return;
    }
  }

  // Catalog providers: fetch products from API and show a select menu
  if (descriptor?.capabilities.includes('catalog_sync')) {
    const label = descriptor.label;
    await interaction.deferUpdate();
    try {
      const [data, guildProducts] = await Promise.all([
        listProviderProducts(selectedType, authUserId),
        convex.query(api.role_rules.getByGuildWithProductNames, {
          apiSecret,
          authUserId,
          guildId: session.guildId,
        }),
      ]);

      if (data.error && (!data.products || data.products.length === 0)) {
        const msg =
          data.error === 'session_expired'
            ? `Your ${label} session has expired. Please reconnect at the creator dashboard, then try again.`
            : sanitizeUserFacingErrorMessage(
                data.error,
                `Couldn't load ${label} products right now.`
              );
        await interaction.editReply({
          content: `${E.X_} ${msg}\n\nRun \`/creator-admin product add\` again after reconnecting.`,
          components: [],
        });
        return;
      }

      const products = data.products ?? [];
      if (products.length === 0) {
        await interaction.editReply({
          content: `${E.X_} No ${label} products found. Add products in your ${label} store first, then try again.`,
          components: [],
        });
        return;
      }

      // Build a set of product IDs already configured for this guild (for this provider)
      const alreadyAddedIds = new Set(
        (guildProducts as Array<{ productId: string; provider?: string }>)
          .filter((gp) => gp.provider === selectedType)
          .map((gp) => gp.productId)
      );

      // Store product name and source maps generically by provider key
      session.productNames = {
        ...session.productNames,
        [selectedType]: Object.fromEntries(products.map((p) => [p.id, p.name])),
      };
      const sourcesMap: Record<string, string> = Object.fromEntries(
        products.flatMap((p) => (p.collaboratorName ? [[p.id, p.collaboratorName]] : []))
      );
      if (Object.keys(sourcesMap).length > 0) {
        session.productSources = { ...session.productSources, [selectedType]: sourcesMap };
      }

      // Sort: own products first → collab products → already-added products at the bottom
      const sortedProducts = [
        ...products.filter((p) => !p.collaboratorName && !alreadyAddedIds.has(p.id)),
        ...products.filter((p) => p.collaboratorName && !alreadyAddedIds.has(p.id)),
        ...products.filter((p) => alreadyAddedIds.has(p.id)),
      ];

      const MAX_OPTIONS = 25;
      const toShow = sortedProducts.slice(0, MAX_OPTIONS);
      const hasCollabProducts = products.some((p) => p.collaboratorName);
      const hasAlreadyAdded = products.some((p) => alreadyAddedIds.has(p.id));
      const catalogSelectId = getCatalogSelectCustomId(
        selectedType,
        interaction.user.id,
        authUserId
      );

      const select = new StringSelectMenuBuilder()
        .setCustomId(catalogSelectId)
        .setPlaceholder(`Select a ${label} product...`)
        .addOptions(
          toShow.map((p) => {
            const productLabel = p.name.length > 100 ? `${p.name.slice(0, 97)}...` : p.name;
            const isAdded = alreadyAddedIds.has(p.id);
            const sourcePrefix = p.collaboratorName ? `[${p.collaboratorName}] ` : '';
            const addedSuffix = isAdded ? ' (already added)' : '';
            const raw = sourcePrefix + p.name + addedSuffix;
            const description = raw.length > 100 ? `${raw.slice(0, 97)}...` : raw || `ID: ${p.id}`;
            const opt = new StringSelectMenuOptionBuilder()
              .setLabel(productLabel)
              .setValue(p.id)
              .setDescription(description);
            if (isAdded) opt.setEmoji('✅');
            return opt;
          })
        );

      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
      const moreNote =
        products.length > MAX_OPTIONS
          ? `\n\n*(Showing first ${MAX_OPTIONS} of ${products.length} products.)*`
          : '';
      const collabNote = hasCollabProducts
        ? '\n\nCollaborator products are shown with **[Name]** in the description.'
        : '';
      const addedNote = hasAlreadyAdded
        ? '\n\n**✅** = already added to this server (re-adding maps additional roles).'
        : '';
      await interaction.editReply({
        content: `**Step 2 of 3:** Select a ${label} product from your store.${moreNote}${collabNote}${addedNote}`,
        components: [row],
      });
    } catch (err) {
      logger.error(`Failed to load ${descriptor.label} products for product setup`, {
        error: err instanceof Error ? err.message : String(err),
        authUserId,
        provider: selectedType,
      });
      await interaction.editReply({
        content: `${E.X_} Couldn't load ${descriptor.label} products right now. Run \`/creator-admin product add\` again in a moment.`,
        components: [],
      });
    }
    return;
  }

  // Providers requiring a per-product credential alongside the product ID (e.g. Payhip)
  if (descriptor?.perProductCredential) {
    const cred = descriptor.perProductCredential;
    // Preserve legacy custom ID for payhip so existing in-flight sessions still work;
    // new providers with perProductCredential use the generic per_product_cred_modal format.
    const modalCustomId =
      selectedType === 'payhip'
        ? `creator_product:payhip_modal:${interaction.user.id}:${authUserId}`
        : `creator_product:per_product_cred_modal:${selectedType}:${interaction.user.id}:${authUserId}`;
    const modal = new ModalBuilder()
      .setCustomId(modalCustomId)
      .setTitle(`Step 2 of 3: ${descriptor.label} Product Details`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(selectedType === 'payhip' ? 'permalink' : 'product_id')
            .setLabel(cred.productIdLabel)
            .setPlaceholder(cred.productIdPlaceholder)
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(selectedType === 'payhip' ? 'product_secret_key' : 'credential_key')
            .setLabel(cred.credentialLabel)
            .setPlaceholder(cred.helpText)
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        )
      );
    await interaction.showModal(modal);
    return;
  }

  // Special 'license' type uses a fixed label since it has no provider descriptor
  if (selectedType === 'license') {
    const modal = new ModalBuilder()
      .setCustomId(`creator_product:url_modal:${interaction.user.id}:${authUserId}`)
      .setTitle('Step 2 of 3: Product Details')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('url_or_id')
            .setLabel('Product ID (or leave generic)')
            .setPlaceholder('Product ID to associate with license keys')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        )
      );
    await interaction.showModal(modal);
    return;
  }

  // Generic text-input modal for all other providers with a productInput config
  const productInput = descriptor?.productInput;
  if (productInput) {
    const modal = new ModalBuilder()
      .setCustomId(`creator_product:url_modal:${interaction.user.id}:${authUserId}`)
      .setTitle('Step 2 of 3: Product Details')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('url_or_id')
            .setLabel(productInput.label)
            .setPlaceholder(productInput.placeholder ?? productInput.description)
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        )
      );
    await interaction.showModal(modal);
    return;
  }

  await interaction.update({
    content: `${E.X_} Unknown product type. Please run \`/creator-admin product add\` again.`,
    components: [],
  });
}

/** Step 2b: Product selected from a catalog API select menu - show role select */
export async function handleProductCatalogSelect(
  interaction: StringSelectMenuInteraction,
  _provider: string,
  userId: string,
  authUserId: string
): Promise<void> {
  const productId = interaction.values[0];
  const sessionKey = getSessionKey(userId, authUserId, interaction.guildId ?? '');
  const session = productSessions.get(sessionKey);

  if (!session || Date.now() > session.expiresAt) {
    await interaction.reply({
      content: `${E.Timer} Session expired. Please run \`/creator-admin product add\` again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  session.urlOrId = productId;

  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId(`creator_product:role_select:${userId}:${authUserId}`)
    .setMinValues(1)
    .setMaxValues(25)
    .setPlaceholder('Select role(s) to assign when verified (1–25)');

  const row = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleSelect);

  await interaction.reply({
    content:
      '**Step 3 of 3:** Which role(s) should users receive when they verify this product? You can select multiple.',
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}
/** Step 2b (Jinxxy): backward-compatible wrapper — delegates to handleProductCatalogSelect */
export async function handleProductJinxxySelect(
  interaction: StringSelectMenuInteraction,
  userId: string,
  authUserId: string
): Promise<void> {
  return handleProductCatalogSelect(interaction, 'jinxxy', userId, authUserId);
}

/** Step 2b (Lemon Squeezy): backward-compatible wrapper — delegates to handleProductCatalogSelect */
export async function handleProductLemonSqueezySelect(
  interaction: StringSelectMenuInteraction,
  userId: string,
  authUserId: string
): Promise<void> {
  return handleProductCatalogSelect(interaction, 'lemonsqueezy', userId, authUserId);
}

/** Step 2b: URL modal submitted - show role select */
export async function handleProductUrlModal(
  interaction: ModalSubmitInteraction,
  userId: string,
  authUserId: string
): Promise<void> {
  const urlOrId = interaction.fields.getTextInputValue('url_or_id')?.trim();
  const sessionKey = getSessionKey(userId, authUserId, interaction.guildId ?? '');
  const session = productSessions.get(sessionKey);

  if (!session || Date.now() > session.expiresAt) {
    await interaction.reply({
      content: `${E.Timer} Session expired. Please run \`/creator-admin product add\` again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  session.urlOrId = urlOrId;

  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId(`creator_product:role_select:${userId}:${authUserId}`)
    .setMinValues(1)
    .setMaxValues(25)
    .setPlaceholder('Select role(s) to assign when verified (1–25)');

  const row = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleSelect);

  await interaction.reply({
    content:
      '**Step 3 of 3:** Which role(s) should users receive when they verify this product? You can select multiple.',
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

function parseRoleIdsFromInput(input: string): string[] {
  return input
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Step 2b (Payhip): Payhip modal submitted - store permalink + secret key, show role select */
export async function handleProductPayhipModal(
  interaction: ModalSubmitInteraction,
  userId: string,
  authUserId: string
): Promise<void> {
  const permalink = interaction.fields.getTextInputValue('permalink')?.trim();
  const productSecretKey = interaction.fields.getTextInputValue('product_secret_key')?.trim();
  const sessionKey = getSessionKey(userId, authUserId, interaction.guildId ?? '');
  const session = productSessions.get(sessionKey);

  if (!session || Date.now() > session.expiresAt) {
    await interaction.reply({
      content: `${E.Timer} Session expired. Please run \`/creator-admin product add\` again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!permalink || !productSecretKey) {
    await interaction.reply({
      content: `${E.X_} Both the Product Permalink and Product Secret Key are required.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  session.urlOrId = permalink;
  session.perProductCredentialKey = productSecretKey;

  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId(`creator_product:role_select:${userId}:${authUserId}`)
    .setMinValues(1)
    .setMaxValues(25)
    .setPlaceholder('Select role(s) to assign when verified (1–25)');

  const row = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleSelect);

  await interaction.reply({
    content:
      '**Step 3 of 3:** Which role(s) should users receive when they verify this product? You can select multiple.',
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

/** Step 2b: Generic per-product credential modal submitted (for new providers).
 * Reads from standard field names 'product_id' and 'credential_key'.
 * Payhip uses the legacy handleProductPayhipModal instead (field names 'permalink'/'product_secret_key').
 */
export async function handleProductPerCredentialModal(
  interaction: ModalSubmitInteraction,
  provider: string,
  userId: string,
  authUserId: string
): Promise<void> {
  const productId = interaction.fields.getTextInputValue('product_id')?.trim();
  const credentialKey = interaction.fields.getTextInputValue('credential_key')?.trim();
  const sessionKey = getSessionKey(userId, authUserId, interaction.guildId ?? '');
  const session = productSessions.get(sessionKey);

  if (!session || Date.now() > session.expiresAt) {
    await interaction.reply({
      content: `${E.Timer} Session expired. Please run \`/creator-admin product add\` again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const descriptor = getProviderDescriptor(provider);
  if (!productId || !credentialKey) {
    const cred = descriptor?.perProductCredential;
    await interaction.reply({
      content: `${E.X_} Both the ${cred?.productIdLabel ?? 'Product ID'} and ${cred?.credentialLabel ?? 'credential key'} are required.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  session.urlOrId = productId;
  session.perProductCredentialKey = credentialKey;

  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId(`creator_product:role_select:${userId}:${authUserId}`)
    .setMinValues(1)
    .setMaxValues(25)
    .setPlaceholder('Select role(s) to assign when verified (1–25)');

  const row = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleSelect);

  await interaction.reply({
    content:
      '**Step 3 of 3:** Which role(s) should users receive when they verify this product? You can select multiple.',
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

/** Step 2c: Discord role modal submitted - show role select for local role */
export async function handleProductDiscordModal(
  interaction: ModalSubmitInteraction,
  userId: string,
  authUserId: string
): Promise<void> {
  const sourceGuildId = interaction.fields.getTextInputValue('source_guild_id')?.trim();
  const roleIdsRaw =
    interaction.fields.getTextInputValue('source_role_ids')?.trim() ??
    interaction.fields.getTextInputValue('source_role_id')?.trim();
  const matchModeRaw = interaction.fields.getTextInputValue('match_mode')?.trim().toLowerCase();
  const sessionKey = getSessionKey(userId, authUserId, interaction.guildId ?? '');
  const session = productSessions.get(sessionKey);

  if (!session || Date.now() > session.expiresAt) {
    await interaction.reply({
      content: `${E.Timer} Session expired. Please run \`/creator-admin product add\` again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sourceRoleIds = parseRoleIdsFromInput(roleIdsRaw ?? '');
  if (sourceRoleIds.length === 0) {
    await interaction.reply({
      content: `${E.X_} Please enter at least one valid Role ID (17–20 digits).`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const validId = /^\d{17,20}$/;
  const invalid = sourceRoleIds.find((id) => !validId.test(id));
  if (invalid) {
    await interaction.reply({
      content: `${E.X_} Invalid Role ID: "${invalid}". Must be 17–20 digits.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  session.sourceGuildId = sourceGuildId;
  session.sourceRoleIds = sourceRoleIds;
  session.sourceRoleId = sourceRoleIds.length === 1 ? sourceRoleIds[0] : undefined;
  session.requiredRoleMatchMode = matchModeRaw === 'all' ? 'all' : 'any';

  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId(`creator_product:role_select:${userId}:${authUserId}`)
    .setMinValues(1)
    .setMaxValues(25)
    .setPlaceholder('Select role(s) to assign in THIS server (1–25)');

  const row = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleSelect);

  await interaction.reply({
    content:
      '**Step 3 of 3:** Which role(s) should users receive **in this server** when they verify? You can select multiple.\n*(Select roles from this server - not the source server.)*',
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

/** "Done" button after web Discord Role setup - fetches result and proceeds to role select */
export async function handleProductDiscordRoleDone(
  interaction: ButtonInteraction,
  userId: string,
  authUserId: string
): Promise<void> {
  const sessionKey = getSessionKey(userId, authUserId, interaction.guildId ?? '');
  const session = productSessions.get(sessionKey);

  if (!session || Date.now() > session.expiresAt) {
    await interaction.update({
      content: `${E.Timer} Session expired. Please run \`/creator-admin product add\` again.`,
      components: [],
    });
    return;
  }

  if (!session.discordRoleSetupToken) {
    await interaction.update({
      content: `${E.X_} Setup token missing. Please run \`/creator-admin product add\` again.`,
      components: [],
    });
    return;
  }

  await interaction.deferUpdate();

  const { apiInternal, apiPublic } = (await import('../lib/apiUrls')).getApiUrls();
  const apiBase = apiPublic ?? apiInternal;
  if (!apiBase) {
    await interaction.editReply({
      content: `${E.X_} API_BASE_URL not configured.`,
      components: [],
    });
    return;
  }

  try {
    const result = await getDiscordRoleSetupResult(session.discordRoleSetupToken);

    if (!result.completed) {
      // Re-show the link button so they can go back
      const setupUrl = `${apiBase}/discord-role-setup#s=${encodeURIComponent(session.discordRoleSetupToken)}`;
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setLabel('Open Setup Page').setStyle(ButtonStyle.Link).setURL(setupUrl),
        new ButtonBuilder()
          .setCustomId(`creator_product:discord_role_done:${userId}:${authUserId}`)
          .setLabel("Done, I've selected it")
          .setEmoji(Emoji.Checkmark)
          .setStyle(ButtonStyle.Success)
      );
      await interaction.editReply({
        content: `${E.Wrench} You haven't saved your selection yet. Open the setup page, pick a server and role, then come back and click **Done**.`,
        components: [row],
      });
      return;
    }

    session.sourceGuildId = result.sourceGuildId;
    session.sourceRoleIds =
      result.sourceRoleIds ?? (result.sourceRoleId ? [result.sourceRoleId] : []);
    session.sourceRoleId = result.sourceRoleId ?? session.sourceRoleIds[0];
    session.requiredRoleMatchMode = result.requiredRoleMatchMode ?? 'any';
    session.discordRoleSetupToken = undefined;

    const roleSelect = new RoleSelectMenuBuilder()
      .setCustomId(`creator_product:role_select:${userId}:${authUserId}`)
      .setMinValues(1)
      .setMaxValues(25)
      .setPlaceholder('Select role(s) to assign in THIS server (1–25)');

    const row = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleSelect);

    await interaction.editReply({
      content:
        '**Step 3 of 3:** Which role(s) should users receive **in this server** when they verify? You can select multiple.\n*(Select roles from this server - not the source server.)*',
      components: [row],
    });
  } catch (err) {
    logger.error('Failed to retrieve Discord role setup result', {
      error: err instanceof Error ? err.message : String(err),
      authUserId,
      tokenPresent: Boolean(session.discordRoleSetupToken),
    });
    await interaction.editReply({
      content: `${E.X_} Couldn’t load your setup result right now. Run \`/creator-admin product add\` again if this keeps happening.`,
      components: [],
    });
  }
}

/** Step 3: Role selected - show confirmation */
export async function handleProductRoleSelect(
  interaction: RoleSelectMenuInteraction,
  userId: string,
  authUserId: string
): Promise<void> {
  const roleIds = interaction.values;
  const sessionKey = getSessionKey(userId, authUserId, interaction.guildId ?? '');
  const session = productSessions.get(sessionKey);

  if (!session || Date.now() > session.expiresAt) {
    await interaction.editReply({
      content: `${E.Timer} Session expired. Please run \`/creator-admin product add\` again.`,
      components: [],
    });
    return;
  }

  session.roleIds = roleIds;
  session.roleId = roleIds[0];

  const guild = interaction.guild;
  const hierarchyCheck = guild ? canBotManageRole(guild, roleIds[0]) : null;

  const typeLabel = (t: string | undefined): string => {
    if (!t) return 'Unknown';
    if (t === 'license') return 'License Key';
    if (t === 'discord_role') return 'Discord Role (other server)';
    return providerLabel(t);
  };

  const detailLines: string[] = [`**Type:** ${typeLabel(session.type)}`];

  if (session.type === 'discord_role') {
    detailLines.push(`**Source Server ID:** \`${session.sourceGuildId}\``);
    const srcIds = session.sourceRoleIds ?? (session.sourceRoleId ? [session.sourceRoleId] : []);
    const matchMode = session.requiredRoleMatchMode ?? 'any';
    detailLines.push(
      `**Source Role(s):** ${srcIds.map((id) => `<@&${id}>`).join(', ')} (${matchMode})`
    );
  } else if (session.urlOrId) {
    let productLabel = session.urlOrId;
    const names = session.type ? session.productNames?.[session.type] : undefined;
    const sources = session.type ? session.productSources?.[session.type] : undefined;
    if (names?.[session.urlOrId]) {
      const name = names[session.urlOrId];
      const src = sources?.[session.urlOrId];
      productLabel = src ? `${name} (via ${src})` : name;
    }
    detailLines.push(`**Product:** ${productLabel}`);
  }

  detailLines.push(`**Assigns Role(s):** ${roleIds.map((id) => `<@&${id}>`).join(', ')}`);

  if (hierarchyCheck && !hierarchyCheck.canManage) {
    detailLines.push('');
    detailLines.push(
      `${E.Wrench} **Role hierarchy warning:** ${hierarchyCheck.reason} The bot will not be able to assign this role until you fix it.`
    );
  }

  const embed = new EmbedBuilder()
    .setTitle(
      hierarchyCheck && !hierarchyCheck.canManage
        ? `${E.Wrench} Ready to add (with warning)`
        : `${E.Checkmark} Ready to add`
    )
    .setColor(hierarchyCheck && !hierarchyCheck.canManage ? 0xfee75c : 0x57f287)
    .setDescription(detailLines.join('\n'));

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`creator_product:confirm_add:${userId}:${authUserId}`)
      .setLabel('Add Product')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`creator_product:cancel_add:${authUserId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

/** Step 4: Confirmed - create the rule */
export async function handleProductConfirmAdd(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  userId: string,
  authUserId: string
): Promise<void> {
  const sessionKey = getSessionKey(userId, authUserId, interaction.guildId ?? '');
  const session = productSessions.get(sessionKey);

  if (!session || Date.now() > session.expiresAt) {
    await interaction.update({
      content: `${E.Timer} Session expired. Please run \`/creator-admin product add\` again.`,
      components: [],
      embeds: [],
    });
    return;
  }

  await interaction.deferUpdate();

  try {
    const {
      type,
      urlOrId,
      sourceGuildId,
      sourceRoleId,
      sourceRoleIds,
      requiredRoleMatchMode,
      roleId,
      roleIds,
      guildId,
      guildLinkId,
    } = session;

    const verifiedRoleIds = roleIds ?? (roleId ? [roleId] : []);
    if (verifiedRoleIds.length === 0) throw new Error('No role selected');

    let productId: string;
    let catalogProductId: Id<'product_catalog'> | undefined;

    if (type === 'discord_role') {
      const reqIds = sourceRoleIds ?? (sourceRoleId ? [sourceRoleId] : []);
      if (!sourceGuildId || reqIds.length === 0) throw new Error('Source guild/role ID missing');

      // Resolve role names at add time so the product list shows a friendly name.
      // The bot resolves from its guild cache (populated via GUILD_CREATE) or makes
      // one GET /guilds/{id}/roles call. Discord.js rate-limits automatically.
      let discordRoleDisplayName: string | undefined;
      try {
        const srcGuild =
          interaction.client.guilds.cache.get(sourceGuildId) ??
          (await interaction.client.guilds.fetch(sourceGuildId).catch(() => null));
        if (srcGuild) {
          const rolesCollection =
            srcGuild.roles.cache.size > 0
              ? srcGuild.roles.cache
              : await srcGuild.roles.fetch().catch(() => null);
          if (rolesCollection) {
            const names = reqIds
              .map((id) => rolesCollection.get(id)?.name)
              .filter((n): n is string => typeof n === 'string');
            if (names.length > 0) {
              const sep = (requiredRoleMatchMode ?? 'any') === 'all' ? ' + ' : ' / ';
              discordRoleDisplayName = `${names.join(sep)} (${srcGuild.name})`;
            }
          }
        }
      } catch {
        // Non-fatal: display name will be resolved at list time via enrichDiscordRoleNames
      }

      const result = await convex.mutation(api.role_rules.addProductFromDiscordRole, {
        apiSecret,
        authUserId,
        sourceGuildId,
        requiredRoleIds: reqIds,
        requiredRoleMatchMode: requiredRoleMatchMode ?? 'any',
        guildId,
        guildLinkId,
        verifiedRoleIds,
        displayName: discordRoleDisplayName,
      });
      productId = result.productId;

      // Enable cross-server Discord role verification via OAuth (user authorizes guilds.members.read)
      // so buyers can verify via "Use Another Server" without manual /creator-admin settings
      const tenant = await convex.query(api.creatorProfiles.getCreatorProfile, {
        apiSecret,
        authUserId,
      });
      const policy = tenant?.policy ?? {};
      const allowed = new Set((policy.allowedSourceGuildIds as string[]) ?? []);
      allowed.add(sourceGuildId);
      await convex.mutation(api.creatorProfiles.updateCreatorPolicy, {
        apiSecret,
        authUserId,
        policy: {
          enableDiscordRoleFromOtherServers: true,
          allowedSourceGuildIds: [...allowed],
        },
      });

      productSessions.delete(sessionKey);

      const modeLabel = requiredRoleMatchMode === 'all' ? 'all' : 'any';
      const rolesMsg = verifiedRoleIds.map((id) => `<@&${id}>`).join(', ');
      track(interaction.user.id, 'product_added', { authUserId, guildId, productId });
      await interaction.editReply({
        content: `${E.Checkmark} Discord role rule added! Users with ${modeLabel} of the source roles will receive ${rolesMsg}.`,
        components: [],
        embeds: [],
      });
      return;
    }

    if (!type) throw new Error('Unknown product type');

    const descriptor = getProviderDescriptor(type);
    if (descriptor?.capabilities.includes('catalog_sync')) {
      // Generic catalog_sync branch — handles gumroad, jinxxy, lemonsqueezy, vrchat, and any future catalog provider.
      const productIdFromApi = urlOrId?.trim();
      if (!productIdFromApi) throw new Error(`No ${descriptor.label} product selected`);
      const productName = session.productNames?.[type]?.[productIdFromApi];
      const collabSource = session.productSources?.[type]?.[productIdFromApi];
      const displayName = productName
        ? collabSource
          ? `${productName} (via ${collabSource})`
          : productName
        : undefined;
      const canonicalUrl = buildCatalogProductUrl(type, productIdFromApi);
      if (!canonicalUrl) throw new Error(`No URL template configured for provider: ${type}`);
      const result = await convex.mutation(api.role_rules.addCatalogProduct, {
        apiSecret,
        authUserId,
        productId: productIdFromApi,
        providerProductRef: productIdFromApi,
        provider: type,
        canonicalUrl,
        supportsAutoDiscovery: descriptor.supportsAutoDiscovery ?? false,
        displayName,
      });
      productId = result.productId;
      catalogProductId = result.catalogProductId;
    } else if (type === 'gumroad_url') {
      // Manual entry: user typed a URL or product ID — parse then resolve via Gumroad public API.
      const parsed = parseProductId('gumroad', urlOrId ?? '');
      if (!parsed.ok) throw new Error(parsed.error);
      const slug = parsed.productId;

      const input = urlOrId ?? '';
      const productUrl = input.startsWith('http') ? input : `https://gumroad.com/l/${slug}`;

      const { resolveGumroadProduct } = await import('@yucp/providers');
      let resolvedProductId: string;
      let resolvedDisplayName: string | undefined;
      try {
        const resolved = await resolveGumroadProduct(productUrl);
        resolvedProductId = resolved.id;
        resolvedDisplayName = resolved.name;
      } catch (resolveErr) {
        throw new Error(
          `Could not resolve Gumroad product from "${productUrl}": ${resolveErr instanceof Error ? resolveErr.message : String(resolveErr)}`
        );
      }

      const result = await convex.mutation(api.role_rules.addProductForProvider, {
        apiSecret,
        authUserId,
        productId: resolvedProductId,
        providerProductRef: resolvedProductId,
        provider: 'gumroad',
        displayName: resolvedDisplayName,
        productUrl: buildCatalogProductUrl('gumroad', resolvedProductId) ?? undefined,
        supportsAutoDiscovery: true,
      });
      productId = result.productId;
      catalogProductId = result.catalogProductId;
    } else if (type === 'license') {
      const parsed = urlOrId?.trim() ?? 'license';
      const result = await convex.mutation(api.role_rules.addProductForProvider, {
        apiSecret,
        authUserId,
        productId: parsed,
        providerProductRef: parsed,
        provider: 'gumroad',
        productUrl: buildCatalogProductUrl('gumroad', parsed) ?? undefined,
        supportsAutoDiscovery: true,
      });
      productId = result.productId;
      catalogProductId = result.catalogProductId;
    } else if (type === 'vrchat_url') {
      // Manual branch: user typed avtr_xxx or a vrchat.com/home/avatar URL
      const parsed = parseProductId('vrchat', urlOrId ?? '');
      if (!parsed.ok) throw new Error(parsed.error);
      const avatarId = parsed.productId;

      let vrchatDisplayName: string | undefined;
      try {
        const nameData = await resolveVrchatProductName({ authUserId, urlOrId: avatarId });
        if (nameData.error === 'session_expired') {
          throw new Error(
            'Your VRChat session has expired. Please reconnect at the creator dashboard, then try adding the avatar again.'
          );
        }
        if (nameData.error === 'not_connected') {
          throw new Error(
            'VRChat is not connected. Please connect your VRChat account in the creator dashboard first.'
          );
        }
        vrchatDisplayName = nameData.name || undefined;
        if (vrchatDisplayName) {
          logger.info('VRChat avatar name resolved', { avatarId, name: vrchatDisplayName });
        } else {
          logger.warn('VRChat avatar name lookup returned empty', { authUserId, avatarId });
        }
      } catch (err) {
        if (
          err instanceof Error &&
          (err.message.includes('session_expired') || err.message.includes('not_connected'))
        ) {
          throw err;
        }
        logger.warn('VRChat avatar name lookup threw — continuing without display name', {
          authUserId,
          avatarId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const result = await convex.mutation(api.role_rules.addProductForProvider, {
        apiSecret,
        authUserId,
        productId: avatarId,
        providerProductRef: avatarId,
        provider: 'vrchat',
        displayName: vrchatDisplayName,
        productUrl: buildCatalogProductUrl('vrchat', avatarId) ?? undefined,
      });
      productId = result.productId;
      catalogProductId = result.catalogProductId;
    } else if (type === 'payhip') {
      const permalink = urlOrId?.trim();
      if (!permalink) throw new Error('No Payhip product permalink provided');
      const credentialKey = session.perProductCredentialKey;
      if (!credentialKey) throw new Error('No Payhip product secret key provided');

      // Save per-product credential first so license verification works immediately.
      const credResult = await upsertProductCredential({
        authUserId,
        providerKey: 'payhip',
        productId: permalink,
        productSecretKey: credentialKey,
      });
      if (!credResult.success) {
        throw new Error(credResult.error ?? 'Failed to save Payhip product secret key');
      }

      const result = await convex.mutation(api.role_rules.addProductForProvider, {
        apiSecret,
        authUserId,
        productId: permalink,
        providerProductRef: permalink,
        provider: 'payhip',
        productUrl: buildCatalogProductUrl('payhip', permalink) ?? undefined,
      });
      productId = result.productId;
      catalogProductId = result.catalogProductId;
    } else {
      throw new Error('Unknown product type');
    }

    const { ruleId } = await convex.mutation(api.role_rules.createRoleRule, {
      apiSecret,
      authUserId,
      guildId,
      guildLinkId,
      productId,
      catalogProductId,
      verifiedRoleIds,
    });
    productSessions.delete(sessionKey);
    track(interaction.user.id, 'product_added', { authUserId, guildId, productId, ruleId });

    let finalProductLabel = productId;
    const savedNames = type ? session.productNames?.[type] : undefined;
    const savedSources = type ? session.productSources?.[type] : undefined;
    if (savedNames?.[productId]) {
      const name = savedNames[productId];
      const src = savedSources?.[productId];
      finalProductLabel = src ? `${name} (via ${src})` : name;
    }
    const rolesMsg = verifiedRoleIds.map((id) => `<@&${id}>`).join(', ');
    await interaction.editReply({
      content: `${E.Checkmark} Product **${finalProductLabel}** mapped to ${rolesMsg}. Users who verify this product will automatically receive the role(s).`,
      components: [],
      embeds: [],
    });
  } catch (err) {
    logger.error('Failed to create product mapping', {
      error: err instanceof Error ? err.message : String(err),
      authUserId,
      guildId: session.guildId,
      type: session.type,
    });
    productSessions.delete(sessionKey);
    await interaction.editReply({
      content: `${E.X_} Couldn’t create this product mapping right now. Run \`/creator-admin product add\` again in a moment.`,
      components: [],
      embeds: [],
    });
  }
}

/** Cancel button - clears session */
export async function handleProductCancelAdd(
  interaction: ButtonInteraction,
  userId: string,
  authUserId: string
): Promise<void> {
  const sessionKey = getSessionKey(userId, authUserId, interaction.guildId ?? '');
  productSessions.delete(sessionKey);

  await interaction.update({
    content: 'Cancelled. No changes were made.',
    components: [],
    embeds: [],
  });
}

/** /creator-admin product list */
export async function handleProductList(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { authUserId: string; guildId: string }
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const rules = await convex.query(api.role_rules.getByGuildWithProductNames, {
    apiSecret,
    authUserId: ctx.authUserId,
    guildId: ctx.guildId,
  });

  // Resolve Discord role names for any entries that don't yet have a stored displayName
  const enrichedRules = await enrichDiscordRoleNames(interaction.client, rules);

  if (!enrichedRules.length) {
    await interaction.editReply({
      content:
        'No product-role mappings for this server. Use `/creator-admin product add` to create one.',
    });
    return;
  }

  const productProviderPrefix = (p: { provider?: string }) => {
    if (!p.provider) return '';
    if (p.provider === 'discord') return '[Discord Role] ';
    return `[${providerLabel(p.provider)}] `;
  };

  const embed = new EmbedBuilder()
    .setTitle('Product-Role Mappings')
    .setColor(0x5865f2)
    .setDescription(
      enrichedRules
        .map((r) => {
          const roleIds = r.verifiedRoleIds ?? (r.verifiedRoleId ? [r.verifiedRoleId] : []);
          const rolesStr = roleIds.map((id) => `<@&${id}>`).join(', ');
          return `• **${productProviderPrefix(r)}${r.displayName ?? r.productId}** → ${rolesStr} ${r.enabled !== false ? E.Checkmark : '(disabled)'}`;
        })
        .join('\n')
    );

  await interaction.editReply({ embeds: [embed] });
}

/** /creator-admin product remove */
export async function handleProductRemove(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { authUserId: string; guildId: string }
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const rules = await convex.query(api.role_rules.getByGuildWithProductNames, {
    apiSecret,
    authUserId: ctx.authUserId,
    guildId: ctx.guildId,
  });

  // Resolve Discord role names for any entries that don't yet have a stored displayName
  const enrichedRules = await enrichDiscordRoleNames(interaction.client, rules);

  if (!enrichedRules.length) {
    await interaction.editReply({
      content: 'No product-role mappings found for this server.',
    });
    return;
  }

  const productProviderPrefix = (p: { provider?: string }) => {
    if (!p.provider) return '';
    if (p.provider === 'discord') return '[Discord Role] ';
    return `[${providerLabel(p.provider)}] `;
  };

  // discord max options is 25
  const toShow = enrichedRules.slice(0, 25);

  const select = new StringSelectMenuBuilder()
    .setCustomId(`creator_product:remove_select:${ctx.authUserId}`)
    .setPlaceholder('Select product(s) to remove (1-25)')
    .setMinValues(1)
    .setMaxValues(toShow.length)
    .addOptions(
      toShow.map((r) => {
        const labelText = `${productProviderPrefix(r)}${r.displayName ?? r.productId}`;
        const label = labelText.length > 100 ? `${labelText.slice(0, 97)}...` : labelText;
        return new StringSelectMenuOptionBuilder().setLabel(label).setValue(r.productId);
      })
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

  const msg =
    toShow.length < enrichedRules.length
      ? `**Select up to 25 products to remove:**\n*(Showing first 25 of ${enrichedRules.length} products)*`
      : '**Select the product(s) you want to remove:**';

  await interaction.editReply({
    content: msg,
    components: [row],
  });
}

/** Step 2 for remove: Products selected in dropdown */
export async function handleProductRemoveSelect(
  interaction: StringSelectMenuInteraction,
  _convex: ConvexHttpClient,
  _apiSecret: string,
  authUserId: string
): Promise<void> {
  const productIds = interaction.values;
  if (!productIds || productIds.length === 0) {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.update({ content: 'No products selected.', components: [] });
    } else {
      await interaction.editReply({ content: 'No products selected.', components: [] });
    }
    return;
  }

  const sessionKey = getSessionKey(interaction.user.id, authUserId, interaction.guildId ?? '');
  let session = productSessions.get(sessionKey);
  if (!session) {
    session = {
      authUserId,
      guildId: interaction.guildId ?? '',
      guildLinkId: '' as Id<'guild_links'>,
      expiresAt: Date.now() + 10 * 60 * 1000,
    };
    productSessions.set(sessionKey, session);
  }

  session.removeProductIds = productIds;
  session.expiresAt = Date.now() + 10 * 60 * 1000;

  const embed = new EmbedBuilder()
    .setTitle(`${E.Wrench} Confirm Removal`)
    .setColor(0xfee75c)
    .setDescription(
      `Are you sure you want to remove **${productIds.length}** product mapping(s)? This will stop granting roles for these products.`
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`creator_product:confirm_remove:${interaction.user.id}:${authUserId}`)
      .setLabel('Remove Products')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`creator_product:cancel_remove:${interaction.user.id}:${authUserId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.update({
    content: '',
    embeds: [embed],
    components: [row],
  });
}

/** Step 3 for remove: Confirmed */
export async function handleProductConfirmRemove(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  userId: string,
  authUserId: string
): Promise<void> {
  // Use discordjs loading function (deferUpdate tells Discord to show a loading state on the button!)
  await interaction.deferUpdate();

  const sessionKey = getSessionKey(userId, authUserId, interaction.guildId ?? '');
  const session = productSessions.get(sessionKey);

  if (!session || Date.now() > session.expiresAt || !session.removeProductIds) {
    await interaction.editReply({
      content: `${E.Timer} Session expired. Please run \`/creator-admin product remove\` again.`,
      embeds: [],
      components: [],
    });
    return;
  }

  const productIds = session.removeProductIds;

  const rules = await convex.query(api.role_rules.getByTenant, {
    apiSecret,
    authUserId,
  });

  let removedCount = 0;
  // biome-ignore lint/suspicious/noExplicitAny: Rule object fields vary
  const removedDiscordRoles: any[] = [];
  const notFoundIds: string[] = [];

  for (const productId of productIds) {
    const matching = rules.filter(
      (r) => r.productId === productId && r.guildId === session.guildId
    );

    if (matching.length === 0) {
      notFoundIds.push(productId);
      continue;
    }

    for (const rule of matching) {
      await convex.mutation(api.role_rules.deleteRoleRule, {
        apiSecret,
        ruleId: rule._id,
      });
      removedCount++;
      if (productId.startsWith('discord_role:')) {
        removedDiscordRoles.push(rule);
      }
    }
  }

  let content = '';

  if (removedCount > 0) {
    content += `${E.Checkmark} Removed ${removedCount} rule(s) for ${productIds.length - notFoundIds.length} product(s).\n\n`;

    for (const r of removedDiscordRoles) {
      let sourceRoleName = '?';
      let targetRoleName = '?';
      try {
        const reqId = r.requiredRoleIds?.[0] ?? r.requiredRoleId;
        if (r.sourceGuildId && reqId) {
          const sourceGuild = await interaction.client.guilds
            .fetch(r.sourceGuildId)
            .catch(() => null);
          const role = sourceGuild ? await sourceGuild.roles.fetch(reqId).catch(() => null) : null;
          sourceRoleName = role?.name ?? reqId;
        }

        const verId = r.verifiedRoleIds?.[0] ?? r.verifiedRoleId;
        if (verId && interaction.guild) {
          const targetRole = await interaction.guild.roles.fetch(verId).catch(() => null);
          targetRoleName = targetRole?.name ?? verId;
        }
      } catch {}
      content += `• **Removed Discord role rule**: Users with **${sourceRoleName}** in the source server will no longer receive **${targetRoleName}** here.\n`;
    }
  }

  if (notFoundIds.length > 0) {
    content += `\nNo rules found for: ${notFoundIds.map((id) => `\`${id}\``).join(', ')}`;
  }

  if (!content) {
    content = 'No mappings were removed.';
  }

  productSessions.delete(sessionKey);
  await interaction.editReply({ content: content.trim(), embeds: [], components: [] });
}

/** Cancel remove button */
export async function handleProductCancelRemove(
  interaction: ButtonInteraction,
  userId: string,
  authUserId: string
): Promise<void> {
  const sessionKey = getSessionKey(userId, authUserId, interaction.guildId ?? '');
  productSessions.delete(sessionKey);

  await interaction.update({
    content: 'Cancelled product removal.',
    embeds: [],
    components: [],
  });
}

// Legacy handleProductAdd kept for backwards compat (maps to interactive flow)
export async function handleProductAdd(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { authUserId: string; guildLinkId: Id<'guild_links'>; guildId: string }
): Promise<void> {
  return handleProductAddInteractive(interaction, ctx, convex, apiSecret);
}
