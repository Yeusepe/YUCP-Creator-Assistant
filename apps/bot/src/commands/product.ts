/**
 * /creator-admin product - Product-role mapping commands
 *
 * add: Interactive guided flow (type select → URL modal → role select → confirm)
 * list: List product-role mappings
 * remove: Remove a product mapping
 */

import { providerLabel, resolveGumroadProductId } from '@yucp/providers';
import { createLogger } from '@yucp/shared';
import type { ConvexHttpClient } from 'convex/browser';
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
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { E, Emoji } from '../lib/emojis';
import { track } from '../lib/posthog';
import { canBotManageRole } from '../lib/roleHierarchy';
import { sanitizeUserFacingErrorMessage } from '../lib/userFacingErrors';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

// In-memory session store for multi-step product add flow
interface ProductSession {
  tenantId: Id<'tenants'>;
  guildLinkId: Id<'guild_links'>;
  guildId: string;
  type?: 'gumroad' | 'jinxxy' | 'lemonsqueezy' | 'license' | 'discord_role' | 'vrchat';
  urlOrId?: string;
  sourceGuildId?: string;
  sourceRoleId?: string;
  sourceRoleIds?: string[];
  requiredRoleMatchMode?: 'any' | 'all';
  roleId?: string;
  roleIds?: string[];
  discordRoleSetupToken?: string;
  /** Jinxxy product id -> name map (for display when adding) */
  jinxxyProductNames?: Record<string, string>;
  /** Jinxxy product id -> collaborator display name (undefined = owner's own store) */
  jinxxyProductSources?: Record<string, string>;
  /** Lemon Squeezy product id -> name map (for display when adding) */
  lsProductNames?: Record<string, string>;
  removeProductIds?: string[];
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

/** Step 1: /creator-admin product add - show type select menu */
export async function handleProductAddInteractive(
  interaction: ChatInputCommandInteraction,
  ctx: { tenantId: Id<'tenants'>; guildLinkId: Id<'guild_links'>; guildId: string }
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
        .setLabel('Lemon Squeezy Product')
        .setDescription('Sold on lemonsqueezy.com')
        .setValue('lemonsqueezy')
        .setEmoji(Emoji.LemonSqueezy),
      new StringSelectMenuOptionBuilder()
        .setLabel('License Key Only')
        .setDescription('Manual license codes (Gumroad or Jinxxy)')
        .setValue('license')
        .setEmoji(Emoji.PersonKey),
      new StringSelectMenuOptionBuilder()
        .setLabel('VRChat Avatar')
        .setDescription('Avatar from vrchat.com/home/avatar/avtr_xxx')
        .setValue('vrchat')
        .setEmoji(Emoji.VRC),
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
  tenantId: Id<'tenants'>
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

      const setupUrl = `${apiBase}/discord-role-setup#s=${encodeURIComponent(token)}`;
      const doneButtonId = `creator_product:discord_role_done:${interaction.user.id}:${tenantId}`;

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
      const data = (await res.json()) as {
        products?: { id: string; name: string; collaboratorName?: string }[];
        error?: string;
      };

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
        products.flatMap((p) => (p.collaboratorName ? [[p.id, p.collaboratorName]] : []))
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
            const label = p.name.length > 100 ? `${p.name.slice(0, 97)}...` : p.name;
            const sourcePrefix = p.collaboratorName ? `[${p.collaboratorName}] ` : '';
            const description =
              (sourcePrefix + p.name).length > 100
                ? `${(sourcePrefix + p.name).slice(0, 97)}...`
                : sourcePrefix + p.name;
            return new StringSelectMenuOptionBuilder()
              .setLabel(label)
              .setValue(p.id)
              .setDescription(description);
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

  // Lemon Squeezy: fetch products from API and show select
  if (selectedType === 'lemonsqueezy') {
    const { apiInternal, apiPublic } = (await import('../lib/apiUrls')).getApiUrls();
    const apiBase = apiPublic ?? apiInternal;
    const apiForFetch = apiInternal ?? apiBase;
    const apiSecret = process.env.CONVEX_API_SECRET;

    if (!apiBase || !apiSecret) {
      await interaction.update({
        content: `${E.X_} API not configured. Set API_BASE_URL and CONVEX_API_SECRET for Lemon Squeezy product selection.`,
        components: [],
      });
      return;
    }

    await interaction.deferUpdate();
    try {
      const res = await fetch(`${apiForFetch}/api/lemonsqueezy/products`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiSecret, tenantId }),
      });
      const data = (await res.json()) as {
        products?: { id: string; name: string }[];
        error?: string;
      };

      if (data.error && (!data.products || data.products.length === 0)) {
        await interaction.editReply({
          content: `${E.X_} ${sanitizeUserFacingErrorMessage(data.error, "Couldn't load Lemon Squeezy products right now.")}\n\nRun \`/creator-admin product add\` again in a moment.`,
          components: [],
        });
        return;
      }

      const products = data.products ?? [];
      if (products.length === 0) {
        await interaction.editReply({
          content: `${E.X_} No Lemon Squeezy products found. Add products in your Lemon Squeezy store first, then try again.`,
          components: [],
        });
        return;
      }

      session.lsProductNames = Object.fromEntries(products.map((p) => [p.id, p.name]));

      const MAX_OPTIONS = 25;
      const toShow = products.slice(0, MAX_OPTIONS);
      const select = new StringSelectMenuBuilder()
        .setCustomId(`creator_product:ls_product_select:${interaction.user.id}:${tenantId}`)
        .setPlaceholder('Select a Lemon Squeezy product...')
        .addOptions(
          toShow.map((p) => {
            const label = p.name.length > 100 ? `${p.name.slice(0, 97)}...` : p.name;
            return new StringSelectMenuOptionBuilder()
              .setLabel(label)
              .setValue(p.id)
              .setDescription(`Product ID: ${p.id}`);
          })
        );

      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
      const moreNote =
        products.length > MAX_OPTIONS
          ? `\n\n*(Showing first ${MAX_OPTIONS} of ${products.length} products.)*`
          : '';
      await interaction.editReply({
        content: `**Step 2 of 3:** Select a Lemon Squeezy product from your store.${moreNote}`,
        components: [row],
      });
    } catch (err) {
      logger.error('Failed to load Lemon Squeezy products for product setup', {
        error: err instanceof Error ? err.message : String(err),
        tenantId,
      });
      await interaction.editReply({
        content: `${E.X_} Couldn't load Lemon Squeezy products right now. Run \`/creator-admin product add\` again in a moment.`,
        components: [],
      });
    }
    return;
  }

  // gumroad, license, vrchat - URL modal
  const labels: Record<string, string> = {
    gumroad: 'Gumroad Product URL or ID',
    license: 'Product ID (or leave generic)',
    vrchat: 'VRChat Avatar URL or ID',
  };
  const placeholders: Record<string, string> = {
    gumroad: 'URL (gumroad.com/l/abc123) or product ID from Gumroad License Key settings',
    license: 'Product ID to associate with license keys',
    vrchat: 'https://vrchat.com/home/avatar/avtr_xxx or avtr_xxx',
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
          .setRequired(true)
      )
    );

  await interaction.showModal(modal);
}

/** Step 2b (Jinxxy): Product selected from API - show role select */
export async function handleProductJinxxySelect(
  interaction: StringSelectMenuInteraction,
  userId: string,
  tenantId: Id<'tenants'>
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

/** Step 2b (Lemon Squeezy): Product selected from API - show role select */
export async function handleProductLemonSqueezySelect(
  interaction: StringSelectMenuInteraction,
  userId: string,
  tenantId: Id<'tenants'>
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

/** Step 2b: URL modal submitted - show role select */
export async function handleProductUrlModal(
  interaction: ModalSubmitInteraction,
  userId: string,
  tenantId: Id<'tenants'>
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

/** Step 2c: Discord role modal submitted - show role select for local role */
export async function handleProductDiscordModal(
  interaction: ModalSubmitInteraction,
  userId: string,
  tenantId: Id<'tenants'>
): Promise<void> {
  const sourceGuildId = interaction.fields.getTextInputValue('source_guild_id')?.trim();
  const roleIdsRaw =
    interaction.fields.getTextInputValue('source_role_ids')?.trim() ??
    interaction.fields.getTextInputValue('source_role_id')?.trim();
  const matchModeRaw = interaction.fields.getTextInputValue('match_mode')?.trim().toLowerCase();
  const sessionKey = getSessionKey(userId, tenantId);
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
    .setCustomId(`creator_product:role_select:${userId}:${tenantId}`)
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
  tenantId: Id<'tenants'>
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
    const res = await fetch(`${apiForFetch}/api/setup/discord-role-result`, {
      headers: { Authorization: `Bearer ${session.discordRoleSetupToken}` },
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const result = (await res.json()) as
      | { completed: false }
      | {
          completed: true;
          sourceGuildId: string;
          sourceRoleId?: string;
          sourceRoleIds?: string[];
          requiredRoleMatchMode?: 'any' | 'all';
        };

    if (!result.completed) {
      // Re-show the link button so they can go back
      const setupUrl = `${apiBase}/discord-role-setup#s=${encodeURIComponent(session.discordRoleSetupToken)}`;
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setLabel('Open Setup Page').setStyle(ButtonStyle.Link).setURL(setupUrl),
        new ButtonBuilder()
          .setCustomId(`creator_product:discord_role_done:${userId}:${tenantId}`)
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
      .setCustomId(`creator_product:role_select:${userId}:${tenantId}`)
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
      tenantId,
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
  tenantId: Id<'tenants'>
): Promise<void> {
  const roleIds = interaction.values;
  const sessionKey = getSessionKey(userId, tenantId);
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
    if (session.type === 'jinxxy' && session.jinxxyProductNames?.[session.urlOrId]) {
      productLabel = session.jinxxyProductNames[session.urlOrId];
    } else if (session.type === 'lemonsqueezy' && session.lsProductNames?.[session.urlOrId]) {
      productLabel = session.lsProductNames[session.urlOrId];
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
      .setCustomId(`creator_product:confirm_add:${userId}:${tenantId}`)
      .setLabel('Add Product')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`creator_product:cancel_add:${tenantId}`)
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
  tenantId: Id<'tenants'>
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
      const result = await convex.mutation(api.role_rules.addProductFromDiscordRole, {
        apiSecret,
        tenantId,
        sourceGuildId,
        requiredRoleIds: reqIds,
        requiredRoleMatchMode: requiredRoleMatchMode ?? 'any',
        guildId,
        guildLinkId,
        verifiedRoleIds,
      });
      productId = result.productId;

      // Enable cross-server Discord role verification via OAuth (user authorizes guilds.members.read)
      // so buyers can verify via "Use Another Server" without manual /creator-admin settings
      const tenant = await convex.query(api.tenants.getTenant, {
        apiSecret,
        tenantId,
      });
      const policy = tenant?.policy ?? {};
      const allowed = new Set((policy.allowedSourceGuildIds as string[]) ?? []);
      allowed.add(sourceGuildId);
      await convex.mutation(api.tenants.updateTenantPolicy, {
        apiSecret,
        tenantId,
        policy: {
          enableDiscordRoleFromOtherServers: true,
          allowedSourceGuildIds: [...allowed],
        },
      });

      productSessions.delete(sessionKey);

      const modeLabel = requiredRoleMatchMode === 'all' ? 'all' : 'any';
      const rolesMsg = verifiedRoleIds.map((id) => `<@&${id}>`).join(', ');
      track(interaction.user.id, 'product_added', { tenantId, guildId, productId });
      await interaction.editReply({
        content: `${E.Checkmark} Discord role rule added! Users with ${modeLabel} of the source roles will receive ${rolesMsg}.`,
        components: [],
        embeds: [],
      });
      return;
    }

    if (type === 'gumroad') {
      const slug = parseGumroadProductId(urlOrId ?? '');
      if (!slug) throw new Error('Could not parse Gumroad product URL or ID');

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
          `Could not resolve Gumroad product ID from "${productUrl}": ${resolveErr instanceof Error ? resolveErr.message : String(resolveErr)}`
        );
      }

      const result = await convex.mutation(api.role_rules.addProductFromGumroad, {
        apiSecret,
        tenantId,
        productId: resolvedProductId,
        providerProductRef: resolvedProductId,
        canonicalSlug: slug,
        displayName: resolvedDisplayName,
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
        ? collabSource
          ? `${productName} (via ${collabSource})`
          : productName
        : undefined;
      const result = await convex.mutation(api.role_rules.addProductFromJinxxy, {
        apiSecret,
        tenantId,
        productId: productIdFromApi,
        providerProductRef: productIdFromApi,
        displayName: displayName ?? undefined,
      });
      productId = result.productId;
      catalogProductId = result.catalogProductId;
    } else if (type === 'lemonsqueezy') {
      const productIdFromApi = urlOrId?.trim();
      if (!productIdFromApi) throw new Error('No Lemon Squeezy product selected');
      const displayName = session.lsProductNames?.[productIdFromApi];
      const result = await convex.mutation(api.role_rules.addProductFromLemonSqueezy, {
        apiSecret,
        tenantId,
        productId: productIdFromApi,
        providerProductRef: productIdFromApi,
        displayName,
      });
      productId = result.productId;
      catalogProductId = result.catalogProductId;
    } else if (type === 'license') {
      const parsed = urlOrId?.trim() ?? 'license';
      const result = await convex.mutation(api.role_rules.addProductFromGumroad, {
        apiSecret,
        tenantId,
        productId: parsed,
        providerProductRef: parsed,
      });
      productId = result.productId;
      catalogProductId = result.catalogProductId;
    } else if (type === 'vrchat') {
      const { extractVrchatAvatarId } = await import('@yucp/providers');
      const avatarId = extractVrchatAvatarId(urlOrId?.trim() ?? '');
      if (!avatarId)
        throw new Error(
          'Could not parse VRChat avatar URL or ID. Use https://vrchat.com/home/avatar/avtr_xxx or avtr_xxx'
        );

      // Best-effort: fetch avatar name via Convex using the tenant owner's stored VRChat session
      let vrchatDisplayName: string | undefined;
      try {
        const convexUrl = process.env.CONVEX_URL ?? '';
        const convexSiteUrl = convexUrl.includes('.convex.cloud')
          ? convexUrl.replace('.convex.cloud', '.convex.site')
          : convexUrl.replace('.convex.cloud', '.convex.site');
        if (convexSiteUrl) {
          const nameRes = await fetch(`${convexSiteUrl}/v1/vrchat/avatar-name`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiSecret}`,
            },
            body: JSON.stringify({ tenantId, avatarId }),
          });
          if (nameRes.ok) {
            const nameData = (await nameRes.json()) as { name: string | null };
            vrchatDisplayName = nameData.name ?? undefined;
          }
        }
      } catch {
        // Non-fatal: proceed without display name
      }

      const result = await convex.mutation(api.role_rules.addProductFromVrchat, {
        apiSecret,
        tenantId,
        productId: avatarId,
        providerProductRef: avatarId,
        displayName: vrchatDisplayName,
      });
      productId = result.productId;
      catalogProductId = result.catalogProductId;
    } else {
      throw new Error('Unknown product type');
    }

    const { ruleId } = await convex.mutation(api.role_rules.createRoleRule, {
      apiSecret,
      tenantId,
      guildId,
      guildLinkId,
      productId,
      catalogProductId,
      verifiedRoleIds,
    });
    productSessions.delete(sessionKey);
    track(interaction.user.id, 'product_added', { tenantId, guildId, productId, ruleId });

    let finalProductLabel = productId;
    if (session.type === 'jinxxy' && session.jinxxyProductNames?.[productId]) {
      const name = session.jinxxyProductNames[productId];
      const src = session.jinxxyProductSources?.[productId];
      finalProductLabel = src ? `${name} (via ${src})` : name;
    } else if (session.type === 'lemonsqueezy' && session.lsProductNames?.[productId]) {
      finalProductLabel = session.lsProductNames[productId];
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

/** Cancel button - clears session */
export async function handleProductCancelAdd(
  interaction: ButtonInteraction,
  userId: string,
  tenantId: Id<'tenants'>
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
  ctx: { tenantId: Id<'tenants'>; guildId: string }
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const rules = await convex.query(api.role_rules.getByGuildWithProductNames, {
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

  const productProviderPrefix = (p: { provider?: string }) => {
    if (!p.provider) return '';
    if (p.provider === 'discord') return '[Discord Role] ';
    return `[${providerLabel(p.provider)}] `;
  };

  const embed = new EmbedBuilder()
    .setTitle('Product-Role Mappings')
    .setColor(0x5865f2)
    .setDescription(
      rules
        .map(
          (r: {
            productId: string;
            displayName: string | null;
            provider?: string;
            verifiedRoleId?: string;
            verifiedRoleIds?: string[];
            enabled?: boolean;
          }) => {
            const roleIds = r.verifiedRoleIds ?? (r.verifiedRoleId ? [r.verifiedRoleId] : []);
            const rolesStr = roleIds.map((id) => `<@&${id}>`).join(', ');
            return `• **${productProviderPrefix(r)}${r.displayName ?? r.productId}** → ${rolesStr} ${r.enabled !== false ? E.Checkmark : '(disabled)'}`;
          }
        )
        .join('\n')
    );

  await interaction.editReply({ embeds: [embed] });
}

/** /creator-admin product remove */
export async function handleProductRemove(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { tenantId: Id<'tenants'>; guildId: string }
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const rules = await convex.query(api.role_rules.getByGuildWithProductNames, {
    tenantId: ctx.tenantId,
    guildId: ctx.guildId,
  });

  if (!rules.length) {
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
  const toShow = rules.slice(0, 25);

  const select = new StringSelectMenuBuilder()
    .setCustomId(`creator_product:remove_select:${ctx.tenantId}`)
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
    toShow.length < rules.length
      ? `**Select up to 25 products to remove:**\n*(Showing first 25 of ${rules.length} products)*`
      : '**Select the product(s) you want to remove:**';

  await interaction.editReply({
    content: msg,
    components: [row],
  });
}

/** Step 2 for remove: Products selected in dropdown */
export async function handleProductRemoveSelect(
  interaction: StringSelectMenuInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  tenantId: Id<'tenants'>
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

  const sessionKey = getSessionKey(interaction.user.id, tenantId);
  let session = productSessions.get(sessionKey);
  if (!session) {
    session = {
      tenantId,
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
      .setCustomId(`creator_product:confirm_remove:${interaction.user.id}:${tenantId}`)
      .setLabel('Remove Products')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`creator_product:cancel_remove:${interaction.user.id}:${tenantId}`)
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
  tenantId: Id<'tenants'>
): Promise<void> {
  // Use discordjs loading function (deferUpdate tells Discord to show a loading state on the button!)
  await interaction.deferUpdate();

  const sessionKey = getSessionKey(userId, tenantId);
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
    tenantId,
  });

  let removedCount = 0;
  // biome-ignore lint/suspicious/noExplicitAny: Rule object fields vary
  const removedDiscordRoles: any[] = [];
  const notFoundIds: string[] = [];

  for (const productId of productIds) {
    const matching = rules.filter((r) => r.productId === productId);

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
  tenantId: Id<'tenants'>
): Promise<void> {
  const sessionKey = getSessionKey(userId, tenantId);
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
  ctx: { tenantId: Id<'tenants'>; guildLinkId: Id<'guild_links'>; guildId: string }
): Promise<void> {
  return handleProductAddInteractive(interaction, ctx);
}
