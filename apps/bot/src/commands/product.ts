/**
 * /creator-admin product — Product-role mapping commands
 *
 * add: Interactive guided flow (type select → URL modal → role select → confirm)
 * list: List product-role mappings
 * remove: Remove a product mapping
 */

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
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  RoleSelectMenuInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../../convex/_generated/api';
import { E, Emoji } from '../lib/emojis';
import { canBotManageRole } from '../lib/roleHierarchy';
import { track } from '../lib/posthog';
import { sanitizeUserFacingErrorMessage } from '../lib/userFacingErrors';
import { resolveGumroadProductId } from '@yucp/providers';
import { createLogger } from '@yucp/shared';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

// In-memory session store for multi-step product add flow
interface ProductSession {
  tenantId: Id<'tenants'>;
  guildLinkId: Id<'guild_links'>;
  guildId: string;
  type?: 'gumroad' | 'jinxxy' | 'license' | 'discord_role';
  urlOrId?: string;
  sourceGuildId?: string;
  sourceRoleId?: string;
  roleId?: string;
  discordRoleSetupToken?: string;
  /** Jinxxy product id -> name map (for display when adding) */
  jinxxyProductNames?: Record<string, string>;
  /** Jinxxy product id -> collaborator display name (undefined = owner's own store) */
  jinxxyProductSources?: Record<string, string>;
  expiresAt: number;
}

const productSessions = new Map<string, ProductSession>();

function getSessionKey(userId: string, tenantId: string): string {
  return `${userId}:${tenantId}`;
}

function cleanExpiredSessions(): void {
  const now = Date.now();
  for (const [key, session] of productSessions.entries()) {
    if (now > session.expiresAt) productSessions.delete(key);
  }
}

function parseGumroadProductId(urlOrId: string): string | null {
  const trimmed = urlOrId.trim();
  const gumroadMatch = trimmed.match(/gumroad\.com\/l\/([a-zA-Z0-9_-]+)/);
  if (gumroadMatch) return gumroadMatch[1];
  const productMatch = trimmed.match(/gumroad\.com\/products\/([a-zA-Z0-9_-]+)/);
  if (productMatch) return productMatch[1];
  if (/^[a-zA-Z0-9_-]{3,}$/.test(trimmed)) return trimmed;
  return null;
}

/** Step 1: /creator-admin product add — show type select menu */
export async function handleProductAddInteractive(
  interaction: ChatInputCommandInteraction,
  ctx: { tenantId: Id<'tenants'>; guildLinkId: Id<'guild_links'>; guildId: string },
): Promise<void> {
  cleanExpiredSessions();

  const sessionKey = getSessionKey(interaction.user.id, ctx.tenantId);
  productSessions.set(sessionKey, {
    tenantId: ctx.tenantId,
    guildLinkId: ctx.guildLinkId,
    guildId: ctx.guildId,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId(`creator_product:type_select:${ctx.tenantId}`)
    .setPlaceholder('Select product type...')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('Gumroad Product')
        .setDescription('Sold on gumroad.com')
        .setValue('gumroad')
        .setEmoji(Emoji.Gumorad),
      new StringSelectMenuOptionBuilder()
        .setLabel('Jinxxy Product')
        .setDescription('Sold on jinxxy.com or jinxxy.app')
        .setValue('jinxxy')
        .setEmoji(Emoji.Jinxxy),
      new StringSelectMenuOptionBuilder()
        .setLabel('License Key Only')
        .setDescription('Manual license codes (Gumroad or Jinxxy)')
        .setValue('license')
        .setEmoji(Emoji.PersonKey),
      new StringSelectMenuOptionBuilder()
        .setLabel('Discord Role (Other Server)')
        .setDescription('User has a specific role in another server')
        .setValue('discord_role')
        .setEmoji(Emoji.Link),
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

  await interaction.reply({
    content: '**Step 1 of 3:** What type of product are you mapping?',
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

/** Step 2: Type selected — show relevant modal */
export async function handleProductTypeSelect(
  interaction: StringSelectMenuInteraction,
  tenantId: Id<'tenants'>,
): Promise<void> {
  const selectedType = interaction.values[0] as ProductSession['type'];
  const sessionKey = getSessionKey(interaction.user.id, tenantId);
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
    const apiForFetch = apiInternal ?? apiBase;
    const apiSecret = process.env.CONVEX_API_SECRET;

    if (!apiBase || !apiSecret) {
      // Fallback: show modal if API_BASE_URL not configured
      const modal = new ModalBuilder()
        .setCustomId(`creator_product:discord_modal:${interaction.user.id}:${tenantId}`)
        .setTitle('Step 2 of 3: Discord Role Details')
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('source_guild_id')
              .setLabel('Source Server ID')
              .setPlaceholder('Right-click the server → Copy Server ID (requires Developer Mode)')
              .setStyle(TextInputStyle.Short)
              .setRequired(true),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('source_role_id')
              .setLabel('Source Role ID')
              .setPlaceholder('Right-click the role → Copy Role ID (requires Developer Mode)')
              .setStyle(TextInputStyle.Short)
              .setRequired(true),
          ),
        );
      await interaction.showModal(modal);
      return;
    }

    // Create a setup session on the API for the web flow (use internal URL when on Zeabur)
    await interaction.deferUpdate();
    try {
      const res = await fetch(`${apiForFetch}/api/setup/discord-role-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId,
          guildId: session.guildId,
          adminDiscordUserId: interaction.user.id,
          apiSecret,
        }),
      });

      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const { token } = (await res.json()) as { token: string };
      session.discordRoleSetupToken = token;

      const setupUrl = `${apiBase}/discord-role-setup?s=${encodeURIComponent(token)}`;
      const doneButtonId = `creator_product:discord_role_done:${interaction.user.id}:${tenantId}`;

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setLabel('Open Setup Page').setStyle(ButtonStyle.Link).setURL(setupUrl),
        new ButtonBuilder()
          .setCustomId(doneButtonId)
          .setLabel("Done, I've selected it")
          .setEmoji(Emoji.Checkmark)
          .setStyle(ButtonStyle.Success),
      );

      await interaction.editReply({
        content:
          '**Step 2 of 3:** Open the setup page to pick a server and role.\n\nSign in with Discord, choose the source server, and enter the role ID. Then come back and click **Done**.',
        components: [row],
      });
    } catch (err) {
      logger.error('Failed to start Discord role setup', {
        error: err instanceof Error ? err.message : String(err),
        tenantId,
        guildId: session.guildId,
      });
      await interaction.editReply({
        content: `${E.X_} Couldn’t start setup right now. Run \`/creator-admin product add\` again in a moment.`,
        components: [],
      });
    }
    return;
  }

  // Jinxxy: fetch products from API and show select (jinx-master style)
  if (selectedType === 'jinxxy') {
    const { apiInternal, apiPublic } = (await import('../lib/apiUrls')).getApiUrls();
    const apiBase = apiPublic ?? apiInternal;
    const apiForFetch = apiInternal ?? apiBase;
    const apiSecret = process.env.CONVEX_API_SECRET;

    if (!apiBase || !apiSecret) {
      await interaction.update({
        content: `${E.X_} API not configured. Set API_BASE_URL and CONVEX_API_SECRET for Jinxxy product selection.`,
        components: [],
      });
      return;
    }

    await interaction.deferUpdate();
    try {
      const res = await fetch(`${apiForFetch}/api/jinxxy/products`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiSecret, tenantId }),
      });
      const data = (await res.json()) as { products?: { id: string; name: string; collaboratorName?: string }[]; error?: string };

      if (data.error && (!data.products || data.products.length === 0)) {
        await interaction.editReply({
          content: `${E.X_} ${sanitizeUserFacingErrorMessage(data.error, 'Couldn’t load Jinxxy products right now.')}\n\nRun \`/creator-admin product add\` again in a moment.`,
          components: [],
        });
        return;
      }

      const products = data.products ?? [];
      if (products.length === 0) {
        await interaction.editReply({
          content: `${E.X_} No Jinxxy products found. Add products in your Jinxxy store first, then try again.`,
          components: [],
        });
        return;
      }

      session.jinxxyProductNames = Object.fromEntries(products.map((p) => [p.id, p.name]));
      session.jinxxyProductSources = Object.fromEntries(
        products.filter((p) => p.collaboratorName).map((p) => [p.id, p.collaboratorName!]),
      );

      // Discord select menu limit: 25 options
      const MAX_OPTIONS = 25;
      const toShow = products.slice(0, MAX_OPTIONS);
      const hasCollabProducts = products.some((p) => p.collaboratorName);
      const select = new StringSelectMenuBuilder()
        .setCustomId(`creator_product:jinxxy_product_select:${interaction.user.id}:${tenantId}`)
        .setPlaceholder('Select a Jinxxy product...')
        .addOptions(
          toShow.map((p) => {
            const label = p.name.length > 100 ? p.name.slice(0, 97) + '...' : p.name;
            const sourcePrefix = p.collaboratorName ? `[${p.collaboratorName}] ` : '';
            const description = (sourcePrefix + p.name).length > 100
              ? (sourcePrefix + p.name).slice(0, 97) + '...'
              : sourcePrefix + p.name;
            return new StringSelectMenuOptionBuilder()
              .setLabel(label)
              .setValue(p.id)
              .setDescription(description);
          }),
        );

      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
      const moreNote =
        products.length > MAX_OPTIONS
          ? `\n\n*(Showing first ${MAX_OPTIONS} of ${products.length} products.)*`
          : '';
      const collabNote = hasCollabProducts
        ? '\n\nCollaborator products are shown with **[Name]** in the description.'
        : '';
      await interaction.editReply({
        content: `**Step 2 of 3:** Select a Jinxxy product from your store.${moreNote}${collabNote}`,
        components: [row],
      });
    } catch (err) {
      logger.error('Failed to load Jinxxy products for product setup', {
        error: err instanceof Error ? err.message : String(err),
        tenantId,
      });
      await interaction.editReply({
        content: `${E.X_} Couldn’t load Jinxxy products right now. Run \`/creator-admin product add\` again in a moment.`,
        components: [],
      });
    }
    return;
  }

  // gumroad, license — URL modal
  const labels: Record<string, string> = {
    gumroad: 'Gumroad Product URL or ID',
    license: 'Product ID (or leave generic)',
  };
  const placeholders: Record<string, string> = {
    gumroad: 'URL (gumroad.com/l/abc123) or product ID from Gumroad License Key settings',
    license: 'Product ID to associate with license keys',
  };

  const modal = new ModalBuilder()
    .setCustomId(`creator_product:url_modal:${interaction.user.id}:${tenantId}`)
    .setTitle('Step 2 of 3: Product Details')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('url_or_id')
          .setLabel(labels[selectedType ?? 'gumroad'] ?? 'Product URL or ID')
          .setPlaceholder(placeholders[selectedType ?? 'gumroad'] ?? '')
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
    );

  await interaction.showModal(modal);
}

/** Step 2b (Jinxxy): Product selected from API — show role select */
export async function handleProductJinxxySelect(
  interaction: StringSelectMenuInteraction,
  userId: string,
  tenantId: Id<'tenants'>,
): Promise<void> {
  const productId = interaction.values[0];
  const sessionKey = getSessionKey(userId, tenantId);
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
    .setCustomId(`creator_product:role_select:${userId}:${tenantId}`)
    .setPlaceholder('Select the role to assign when verified...');

  const row = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleSelect);

  await interaction.reply({
    content: '**Step 3 of 3:** Which role should users receive when they verify this product?',
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

/** Step 2b: URL modal submitted — show role select */
export async function handleProductUrlModal(
  interaction: ModalSubmitInteraction,
  userId: string,
  tenantId: Id<'tenants'>,
): Promise<void> {
  const urlOrId = interaction.fields.getTextInputValue('url_or_id')?.trim();
  const sessionKey = getSessionKey(userId, tenantId);
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
    .setCustomId(`creator_product:role_select:${userId}:${tenantId}`)
    .setPlaceholder('Select the role to assign when verified...');

  const row = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleSelect);

  await interaction.reply({
    content: '**Step 3 of 3:** Which role should users receive when they verify this product?',
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

/** Step 2c: Discord role modal submitted — show role select for local role */
export async function handleProductDiscordModal(
  interaction: ModalSubmitInteraction,
  userId: string,
  tenantId: Id<'tenants'>,
): Promise<void> {
  const sourceGuildId = interaction.fields.getTextInputValue('source_guild_id')?.trim();
  const sourceRoleId = interaction.fields.getTextInputValue('source_role_id')?.trim();
  const sessionKey = getSessionKey(userId, tenantId);
  const session = productSessions.get(sessionKey);

  if (!session || Date.now() > session.expiresAt) {
    await interaction.reply({
      content: `${E.Timer} Session expired. Please run \`/creator-admin product add\` again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  session.sourceGuildId = sourceGuildId;
  session.sourceRoleId = sourceRoleId;

  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId(`creator_product:role_select:${userId}:${tenantId}`)
    .setPlaceholder('Select the role to assign in THIS server...');

  const row = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleSelect);

  await interaction.reply({
    content:
      '**Step 3 of 3:** Which role should users receive **in this server** when they verify?\n*(Select a role from this server — not the source server.)*',
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

/** "Done" button after web Discord Role setup — fetches result and proceeds to role select */
export async function handleProductDiscordRoleDone(
  interaction: ButtonInteraction,
  userId: string,
  tenantId: Id<'tenants'>,
): Promise<void> {
  const sessionKey = getSessionKey(userId, tenantId);
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
  const apiForFetch = apiInternal ?? apiBase;
  if (!apiBase) {
    await interaction.editReply({
      content: `${E.X_} API_BASE_URL not configured.`,
      components: [],
    });
    return;
  }

  try {
    const res = await fetch(
      `${apiForFetch}/api/setup/discord-role-result?s=${encodeURIComponent(session.discordRoleSetupToken)}`,
    );
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const result = (await res.json()) as
      | { completed: false }
      | { completed: true; sourceGuildId: string; sourceRoleId: string };

    if (!result.completed) {
      // Re-show the link button so they can go back
      const setupUrl = `${apiBase}/discord-role-setup?s=${encodeURIComponent(session.discordRoleSetupToken)}`;
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setLabel('Open Setup Page').setStyle(ButtonStyle.Link).setURL(setupUrl),
        new ButtonBuilder()
          .setCustomId(`creator_product:discord_role_done:${userId}:${tenantId}`)
          .setLabel("Done, I've selected it")
          .setEmoji(Emoji.Checkmark)
          .setStyle(ButtonStyle.Success),
      );
      await interaction.editReply({
        content:
          `${E.Wrench} You haven't saved your selection yet. Open the setup page, pick a server and role, then come back and click **Done**.`,
        components: [row],
      });
      return;
    }

    session.sourceGuildId = result.sourceGuildId;
    session.sourceRoleId = result.sourceRoleId;
    session.discordRoleSetupToken = undefined;

    const roleSelect = new RoleSelectMenuBuilder()
      .setCustomId(`creator_product:role_select:${userId}:${tenantId}`)
      .setPlaceholder('Select the role to assign in THIS server...');

    const row = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleSelect);

    await interaction.editReply({
      content:
        '**Step 3 of 3:** Which role should users receive **in this server** when they verify?\n*(Select a role from this server — not the source server.)*',
      components: [row],
    });
  } catch (err) {
    logger.error('Failed to retrieve Discord role setup result', {
      error: err instanceof Error ? err.message : String(err),
      tenantId,
      tokenPresent: Boolean(session.discordRoleSetupToken),
    });
    await interaction.editReply({
      content: `${E.X_} Couldn’t load your setup result right now. Run \`/creator-admin product add\` again if this keeps happening.`,
      components: [],
    });
  }
}

/** Step 3: Role selected — show confirmation */
export async function handleProductRoleSelect(
  interaction: RoleSelectMenuInteraction,
  userId: string,
  tenantId: Id<'tenants'>,
): Promise<void> {
  const roleId = interaction.values[0];
  const sessionKey = getSessionKey(userId, tenantId);
  const session = productSessions.get(sessionKey);

  if (!session || Date.now() > session.expiresAt) {
    await interaction.update({
      content: `${E.Timer} Session expired. Please run \`/creator-admin product add\` again.`,
      components: [],
    });
    return;
  }

  session.roleId = roleId;

  const guild = interaction.guild;
  const hierarchyCheck = guild ? canBotManageRole(guild, roleId) : null;

  const typeLabels: Record<string, string> = {
    gumroad: 'Gumroad',
    jinxxy: 'Jinxxy',
    license: 'License Key',
    discord_role: 'Discord Role (other server)',
  };

  const detailLines: string[] = [
    `**Type:** ${typeLabels[session.type ?? 'gumroad'] ?? session.type}`,
  ];

  if (session.type === 'discord_role') {
    detailLines.push(`**Source Server ID:** \`${session.sourceGuildId}\``);
    detailLines.push(`**Source Role:** <@&${session.sourceRoleId}>`);
  } else if (session.urlOrId) {
    const productLabel =
      session.type === 'jinxxy' && session.jinxxyProductNames?.[session.urlOrId]
        ? session.jinxxyProductNames[session.urlOrId]
        : session.urlOrId;
    detailLines.push(`**Product:** ${productLabel}`);
  }

  detailLines.push(`**Assigns Role:** <@&${roleId}>`);

  if (hierarchyCheck && !hierarchyCheck.canManage) {
    detailLines.push('');
    detailLines.push(
      `${E.Wrench} **Role hierarchy warning:** ${hierarchyCheck.reason} The bot will not be able to assign this role until you fix it.`,
    );
  }

  const embed = new EmbedBuilder()
    .setTitle(hierarchyCheck && !hierarchyCheck.canManage ? `${E.Wrench} Ready to add (with warning)` : `${E.Checkmark} Ready to add`)
    .setColor(hierarchyCheck && !hierarchyCheck.canManage ? 0xfee75c : 0x57f287)
    .setDescription(detailLines.join('\n'));

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`creator_product:confirm_add:${userId}:${tenantId}`)
      .setLabel('Add Product')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`creator_product:cancel_add:${tenantId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({ embeds: [embed], components: [row] });
}

/** Step 4: Confirmed — create the rule */
export async function handleProductConfirmAdd(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  userId: string,
  tenantId: Id<'tenants'>,
): Promise<void> {
  const sessionKey = getSessionKey(userId, tenantId);
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
    const { type, urlOrId, sourceGuildId, sourceRoleId, roleId, guildId, guildLinkId } = session;

    if (!roleId) throw new Error('No role selected');

    let productId: string;
    let catalogProductId: Id<'product_catalog'> | undefined;

    if (type === 'discord_role') {
      if (!sourceGuildId || !sourceRoleId) throw new Error('Source guild/role ID missing');
      const result = await convex.mutation(api.role_rules.addProductFromDiscordRole as any, {
        apiSecret,
        tenantId,
        sourceGuildId,
        requiredRoleId: sourceRoleId,
        guildId,
        guildLinkId,
        verifiedRoleId: roleId,
      });
      productId = result.productId;

      // Enable cross-server Discord role verification via OAuth (user authorizes guilds.members.read)
      // so buyers can verify via "Use Another Server" without manual /creator-admin settings
      const tenant = await convex.query(api.tenants.getTenant as any, {
        apiSecret,
        tenantId,
      });
      const policy = tenant?.policy ?? {};
      const allowed = new Set((policy.allowedSourceGuildIds as string[]) ?? []);
      allowed.add(sourceGuildId);
      await convex.mutation(api.tenants.updateTenantPolicy as any, {
        apiSecret,
        tenantId,
        policy: {
          enableDiscordRoleFromOtherServers: true,
          allowedSourceGuildIds: [...allowed],
        },
      });

      productSessions.delete(sessionKey);

      track(interaction.user.id, 'product_added', { tenantId, guildId, productId });
      await interaction.editReply({
        content: `${E.Checkmark} Discord role rule added! Users with the source role will receive <@&${roleId}>.`,
        components: [],
        embeds: [],
      });
      return;
    }

    if (type === 'gumroad') {
      const slug = parseGumroadProductId(urlOrId ?? '');
      if (!slug) throw new Error('Could not parse Gumroad product URL or ID');

      // Reconstruct the product URL so we can resolve the real product_id.
      // Gumroad products created after Jan 2023 require the internal product_id
      // (e.g. "QAJc7ErxdAC815P5P8R89g=="), not the URL slug.
      const productUrl = (urlOrId ?? '').startsWith('http')
        ? urlOrId!
        : `https://gumroad.com/l/${slug}`;

      let resolvedProductId: string;
      try {
        resolvedProductId = await resolveGumroadProductId(productUrl);
      } catch (resolveErr) {
        throw new Error(
          `Could not resolve Gumroad product ID from "${productUrl}": ${resolveErr instanceof Error ? resolveErr.message : String(resolveErr)}`,
        );
      }

      const result = await convex.mutation(api.role_rules.addProductFromGumroad as any, {
        apiSecret,
        tenantId,
        productId: resolvedProductId,
        providerProductRef: resolvedProductId,
        canonicalSlug: slug,
      });
      productId = result.productId;
      catalogProductId = result.catalogProductId;
    } else if (type === 'jinxxy') {
      // Product ID comes from Jinxxy API (product select), not URL parsing
      const productIdFromApi = urlOrId?.trim();
      if (!productIdFromApi) throw new Error('No Jinxxy product selected');
      const productName = session.jinxxyProductNames?.[productIdFromApi];
      const collabSource = session.jinxxyProductSources?.[productIdFromApi];
      const displayName = productName
        ? (collabSource ? `${productName} (via ${collabSource})` : productName)
        : undefined;
      const result = await convex.mutation(api.role_rules.addProductFromJinxxy as any, {
        apiSecret,
        tenantId,
        productId: productIdFromApi,
        providerProductRef: productIdFromApi,
        displayName: displayName ?? undefined,
      });
      productId = result.productId;
      catalogProductId = result.catalogProductId;
    } else if (type === 'license') {
      const parsed = urlOrId?.trim() ?? 'license';
      const result = await convex.mutation(api.role_rules.addProductFromGumroad as any, {
        apiSecret,
        tenantId,
        productId: parsed,
        providerProductRef: parsed,
      });
      productId = result.productId;
      catalogProductId = result.catalogProductId;
    } else {
      throw new Error('Unknown product type');
    }

    const { ruleId } = await convex.mutation(api.role_rules.createRoleRule as any, {
      apiSecret,
      tenantId,
      guildId,
      guildLinkId,
      productId,
      catalogProductId,
      verifiedRoleId: roleId,
    });
    productSessions.delete(sessionKey);
    track(interaction.user.id, 'product_added', { tenantId, guildId, productId, ruleId });

    let finalProductLabel = productId;
    if (session.type === 'jinxxy' && session.jinxxyProductNames?.[productId]) {
      const name = session.jinxxyProductNames[productId];
      const src = session.jinxxyProductSources?.[productId];
      finalProductLabel = src ? `${name} (via ${src})` : name;
    }
    await interaction.editReply({
      content: `${E.Checkmark} Product **${finalProductLabel}** mapped to <@&${roleId}>. Users who verify this product will automatically receive the role.`,
      components: [],
      embeds: [],
    });
  } catch (err) {
    logger.error('Failed to create product mapping', {
      error: err instanceof Error ? err.message : String(err),
      tenantId,
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

/** Cancel button — clears session */
export async function handleProductCancelAdd(
  interaction: ButtonInteraction,
  userId: string,
  tenantId: Id<'tenants'>,
): Promise<void> {
  const sessionKey = getSessionKey(userId, tenantId);
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
  _apiSecret: string,
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const rules = await convex.query(api.role_rules.getByGuildWithProductNames as any, {
    tenantId: ctx.tenantId,
    guildId: ctx.guildId,
  });

  if (!rules.length) {
    await interaction.editReply({
      content:
        'No product-role mappings for this server. Use `/creator-admin product add` to create one.',
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('Product-Role Mappings')
    .setColor(0x5865f2)
    .setDescription(
      rules
        .map(
          (r: { productId: string; displayName: string | null; verifiedRoleId?: string; enabled?: boolean }) =>
            `• **${r.displayName ?? r.productId}** → <@&${r.verifiedRoleId}> ${r.enabled !== false ? E.Checkmark : '(disabled)'}`,
        )
        .join('\n'),
    );

  await interaction.editReply({ embeds: [embed] });
}

/** /creator-admin product remove */
export async function handleProductRemove(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  const productId = interaction.options.getString('product_id', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const rules = await convex.query(api.role_rules.getByTenant as any, {
    tenantId: ctx.tenantId,
  });
  const matching = rules.filter((r: { productId: string }) => r.productId === productId);

  if (!matching.length) {
    await interaction.editReply({
      content: `No rule found for product \`${productId}\`. Use \`/creator-admin product list\` to see all mappings.`,
    });
    return;
  }

  for (const rule of matching) {
    await convex.mutation(api.role_rules.deleteRoleRule as any, {
      apiSecret,
      ruleId: rule._id,
    });
  }

  let content: string;
  const isDiscordRole = productId.startsWith('discord_role:');
  if (isDiscordRole && matching.length > 0) {
    const r = matching[0] as { sourceGuildId?: string; requiredRoleId?: string; verifiedRoleId?: string };
    let sourceRoleName = '?';
    let targetRoleName = '?';
    try {
      if (r.sourceGuildId && r.requiredRoleId) {
        const sourceGuild = await interaction.client.guilds.fetch(r.sourceGuildId).catch(() => null);
        const role = sourceGuild ? await sourceGuild.roles.fetch(r.requiredRoleId!).catch(() => null) : null;
        sourceRoleName = role?.name ?? '?';
      }
      if (r.verifiedRoleId && interaction.guild) {
        const targetRole = await interaction.guild.roles.fetch(r.verifiedRoleId).catch(() => null);
        targetRoleName = targetRole?.name ?? '?';
      }
    } catch {
      /* use fallbacks */
    }
    content =
      `**Removed Discord role rule** (${matching.length} mapping${matching.length > 1 ? 's' : ''})\n\n` +
      `Users with **${sourceRoleName}** in the source server will no longer receive **${targetRoleName}** here.`;
  } else {
    content = `Removed ${matching.length} rule(s) for product \`${productId}\`.`;
  }

  await interaction.editReply({ content });
}

// Legacy handleProductAdd kept for backwards compat (maps to interactive flow)
export async function handleProductAdd(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { tenantId: Id<'tenants'>; guildLinkId: Id<'guild_links'>; guildId: string },
): Promise<void> {
  return handleProductAddInteractive(interaction, ctx);
}
