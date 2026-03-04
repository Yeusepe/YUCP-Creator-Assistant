/**
 * /creator — State-aware verification status panel (user command)
 * /creator-admin spawn-verify — Spawn verify button in channel
 * Verify button interaction — shows same status panel
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
} from 'discord.js';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../../convex/_generated/api';
import { E, Emoji } from '../lib/emojis';
import { track } from '../lib/posthog';

const VERIFY_PREFIX = 'creator_verify:';

/** Default embed for spawn-verify: explains verification (scannable, benefit-first, plain language). */
const DEFAULT_SPAWN_TITLE = `Verify your purchase ${E.Assistant}`;
const DEFAULT_SPAWN_DESCRIPTION = [
  `${E.PointDown} Click the button below to open the verification panel.`,
  '',
  `${E.Link} **Sign in** — Connect ${E.Gumorad} Gumroad or ${E.Discord} Discord. We recognize your purchases and grant your role automatically.`,
  '',
  `${E.KeyCloud} **One license key, then you’re set** — Using ${E.Jinxxy} Jinxxy or a ${E.Gumorad} Gumroad license? Enter one key once. We link your account and sync all past and future purchases so you only verify once.`,
  '',
  'Connections are secure and used only for verification.',
].join('\n');
const DEFAULT_SPAWN_BUTTON_TEXT = 'Verify';
const DEFAULT_SPAWN_COLOR = 0x5865f2; // Discord Blurple

// Semantic colors
const COLOR_GRAY = 0x4f545c;   // Nothing connected
const COLOR_ORANGE = 0xfaa61a; // Connected but no purchases found
const COLOR_GREEN = 0x57f287;  // Verified

type VerifyState = 'nothing' | 'connected_no_products' | 'verified';

interface VerifyData {
  state: VerifyState;
  linkedAccounts: Array<{ provider: string; status: string }>;
  productIds: string[];
  hasGumroad: boolean;
  hasDiscord: boolean;
}

async function fetchVerifyData(
  userId: string,
  tenantId: Id<'tenants'>,
  convex: ConvexHttpClient,
): Promise<VerifyData> {
  const subjectResult = await convex.query(api.subjects.getSubjectByDiscordId as any, {
    discordUserId: userId,
  });

  let linkedAccounts: Array<{ provider: string; status: string }> = [];
  let productIds: string[] = [];

  if (subjectResult.found) {
    const accountsResult = await convex.query(api.subjects.getSubjectWithAccounts as any, {
      subjectId: subjectResult.subject._id,
      tenantId,
    });
    if (accountsResult.found) {
      linkedAccounts = accountsResult.externalAccounts;
    }

    const entitlements = await convex.query(api.entitlements.getEntitlementsBySubject as any, {
      tenantId,
      subjectId: subjectResult.subject._id,
      includeInactive: false,
    });
    productIds = [...new Set((entitlements as Array<{ productId: string }>).map((e) => e.productId))];
  }

  const hasGumroad = linkedAccounts.some((a) => a.provider === 'gumroad' && a.status === 'active');
  const hasDiscord = linkedAccounts.some((a) => a.provider === 'discord' && a.status === 'active');
  const activeAccounts = linkedAccounts.filter((a) => a.status === 'active');

  let state: VerifyState;
  if (activeAccounts.length === 0) {
    state = 'nothing';
  } else if (productIds.length === 0) {
    state = 'connected_no_products';
  } else {
    state = 'verified';
  }

  return { state, linkedAccounts, productIds, hasGumroad, hasDiscord };
}

function providerLabel(p: string): string {
  return p === 'gumroad' ? 'Gumroad' : p === 'discord' ? 'Discord' : p === 'jinxxy' ? 'Jinxxy' : p;
}

function buildStatusContainer(
  data: VerifyData,
  tenantId: Id<'tenants'>,
  guildId: string,
  apiBaseUrl: string | undefined,
  userId?: string,
): ContainerBuilder {
  const { state, linkedAccounts, productIds, hasGumroad, hasDiscord } = data;

  const accentColor =
    state === 'nothing' ? COLOR_GRAY :
      state === 'connected_no_products' ? COLOR_ORANGE :
        COLOR_GREEN;

  const container = new ContainerBuilder().setAccentColor(accentColor);

  // Title
  if (state === 'verified') {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('## 🎉 You\'re Verified!'),
    );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('## <:Key:1478609887012585492> Your Verification Status'),
    );
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
  );

  // Connected accounts
  const gumroadStatus = hasGumroad ? '✅ Connected' : '— Not connected';
  const discordStatus = hasDiscord ? '✅ Connected' : '— Not connected';
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `**Connected Accounts**\n${E.Gumorad} Gumroad — ${gumroadStatus}\n${E.Discord} Discord (other server) — ${discordStatus}`,
    ),
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
  );

  // Verified products
  if (productIds.length > 0) {
    const productList = productIds.map((p) => `• ${p}`).join('\n');
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**Verified Products**\n${productList}`),
    );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('**Verified Products**\nNone yet'),
    );
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
  );

  // Build OAuth URLs
  const returnTo = `https://discord.com/channels/${guildId}`;
  const redirectUri = apiBaseUrl
    ? `${apiBaseUrl}/verify-success?returnTo=${encodeURIComponent(returnTo)}`
    : '';
  // discordUserId MUST be passed so the verification session can link the
  // Gumroad account to this Discord user. Without it, syncUserFromProvider
  // stores it under a synthetic 'gumroad:xxx' subject, not the Discord one.
  const gumroadParams = new URLSearchParams({ tenantId, mode: 'gumroad', redirectUri });
  if (userId) gumroadParams.set('discordUserId', userId);
  const gumroadUrl = apiBaseUrl
    ? `${apiBaseUrl}/api/verification/begin?${gumroadParams.toString()}`
    : null;
  const discordRoleParams = new URLSearchParams({ tenantId, mode: 'discord_role', redirectUri });
  if (userId) discordRoleParams.set('discordUserId', userId);
  const discordRoleUrl = apiBaseUrl
    ? `${apiBaseUrl}/api/verification/begin?${discordRoleParams.toString()}`
    : null;

  if (state === 'nothing') {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('👇 Choose how to verify your purchase:'),
    );

    const buttons: ButtonBuilder[] = [];

    if (gumroadUrl) {
      buttons.push(
        new ButtonBuilder()
          .setLabel('Connect Gumroad')
          .setEmoji(Emoji.Gumorad)
          .setStyle(ButtonStyle.Link)
          .setURL(gumroadUrl),
      );
    }

    buttons.push(
      new ButtonBuilder()
        .setCustomId(`${VERIFY_PREFIX}license:${tenantId}`)
        .setLabel('Use License Key')
        .setEmoji(Emoji.KeyCloud)
        .setStyle(ButtonStyle.Secondary),
    );

    if (discordRoleUrl) {
      buttons.push(
        new ButtonBuilder()
          .setLabel('Use Another Server')
          .setEmoji(Emoji.Discord)
          .setStyle(ButtonStyle.Link)
          .setURL(discordRoleUrl),
      );
    }

    if (buttons.length > 0) {
      container.addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons),
      );
    }
  } else if (state === 'connected_no_products') {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        'Your account is connected but we didn\'t find any matching purchases.\nMake sure you\'re using the account you bought with, or try another method:',
      ),
    );

    const buttons: ButtonBuilder[] = [];

    if (gumroadUrl && !hasGumroad) {
      buttons.push(
        new ButtonBuilder()
          .setLabel('Connect Gumroad')
          .setEmoji(Emoji.Gumorad)
          .setStyle(ButtonStyle.Link)
          .setURL(gumroadUrl),
      );
    }

    buttons.push(
      new ButtonBuilder()
        .setCustomId(`${VERIFY_PREFIX}license:${tenantId}`)
        .setLabel('Use License Key')
        .setEmoji(Emoji.Key)
        .setStyle(ButtonStyle.Secondary),
    );

    if (discordRoleUrl && !hasDiscord) {
      buttons.push(
        new ButtonBuilder()
          .setLabel('Use Another Server')
          .setEmoji(Emoji.Discord)
          .setStyle(ButtonStyle.Link)
          .setURL(discordRoleUrl),
      );
    }

    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(0, 3)),
    );

    // Disconnect row: show a button for each connected provider
    const activeProviders = linkedAccounts.filter((a) => a.status === 'active');
    const disconnectButtons = activeProviders.map((a) =>
      new ButtonBuilder()
        .setCustomId(`${VERIFY_PREFIX}disconnect:${a.provider}`)
        .setLabel(`Disconnect ${providerLabel(a.provider)}`)
        .setStyle(ButtonStyle.Danger),
    );
    if (disconnectButtons.length > 0) {
      container.addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(...disconnectButtons.slice(0, 5)),
      );
    }
  } else {
    // Verified state
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        'You have access to this server. Use the buttons below to manage your connection.',
      ),
    );

    const providerEmoji = (p: string) =>
      p === 'gumroad' ? Emoji.Gumorad : p === 'discord' ? Emoji.Discord : p === 'jinxxy' ? Emoji.Jinxxy : Emoji.Key;
    const activeProviders = linkedAccounts.filter((a) => a.status === 'active');
    const primaryButtons = [
      new ButtonBuilder()
        .setCustomId(`${VERIFY_PREFIX}add_more:${tenantId}`)
        .setLabel('Add another account')
        .setEmoji(Emoji.Link)
        .setStyle(ButtonStyle.Secondary),
      ...activeProviders.map((a) =>
        new ButtonBuilder()
          .setCustomId(`${VERIFY_PREFIX}disconnect:${a.provider}`)
          .setLabel(`Disconnect ${providerLabel(a.provider)}`)
          .setEmoji(providerEmoji(a.provider))
          .setStyle(ButtonStyle.Danger),
      ),
    ];
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(...primaryButtons.slice(0, 5)),
    );
  }

  return container;
}

/** /creator slash command — shows state-aware verification status panel */
export async function handleCreatorCommand(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  _apiSecret: string,
  apiBaseUrl: string | undefined,
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  track(interaction.user.id, 'command_used', {
    command: 'creator',
    guildId: ctx.guildId,
    tenantId: ctx.tenantId,
    userId: interaction.user.id,
  });

  try {
    const data = await fetchVerifyData(interaction.user.id, ctx.tenantId, convex);
    const container = buildStatusContainer(data, ctx.tenantId, ctx.guildId, apiBaseUrl, interaction.user.id);
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
    });
  } catch (err) {
    await interaction.editReply({ content: 'An error occurred. Please try again.' });
  }
}

/** "Verify" button in channel — shows same state-aware panel */
export async function handleVerifyStartButton(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  _apiSecret: string,
  apiBaseUrl: string | undefined,
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  track(interaction.user.id, 'spawn_button_clicked', {
    guildId: ctx.guildId,
    userId: interaction.user.id,
  });

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const data = await fetchVerifyData(interaction.user.id, ctx.tenantId, convex);
    const container = buildStatusContainer(data, ctx.tenantId, ctx.guildId, apiBaseUrl, interaction.user.id);
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
    });
  } catch (err) {
    await interaction.editReply({ content: 'An error occurred. Please try again.' });
  }
}

/** "Add another account" button — shows connect options overlay */
export async function handleVerifyAddMore(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  _apiSecret: string,
  apiBaseUrl: string | undefined,
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  await interaction.deferUpdate();

  try {
    const data = await fetchVerifyData(interaction.user.id, ctx.tenantId, convex);
    // Force 'nothing' state to show all connect options regardless of current state
    const container = buildStatusContainer(
      { ...data, state: 'nothing' },
      ctx.tenantId,
      ctx.guildId,
      apiBaseUrl,
      interaction.user.id,
    );
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
    });
  } catch (err) {
    await interaction.editReply({ content: 'An error occurred. Please try again.' });
  }
}

/** /creator-admin spawn-verify — post non-ephemeral verify button in channel */
export async function handleVerifySpawn(
  interaction: ChatInputCommandInteraction,
  _convex: ConvexHttpClient,
  _apiBaseUrl: string | undefined,
  _ctx: { tenantId: Id<'tenants'>; guildLinkId: Id<'guild_links'>; guildId: string },
): Promise<void> {
  const title = interaction.options.getString('title') ?? DEFAULT_SPAWN_TITLE;
  const description = interaction.options.getString('description') ?? DEFAULT_SPAWN_DESCRIPTION;
  const buttonText = interaction.options.getString('button_text') ?? DEFAULT_SPAWN_BUTTON_TEXT;
  const colorStr = interaction.options.getString('color');
  const imageUrl = interaction.options.getString('image_url');

  let color = DEFAULT_SPAWN_COLOR;
  if (colorStr && /^#[0-9A-Fa-f]{6}$/.test(colorStr)) {
    color = parseInt(colorStr.substring(1), 16);
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setFooter({ text: 'Creator Assistant · Secure verification' });

  if (imageUrl) {
    embed.setImage(imageUrl);
  }

  const button = new ButtonBuilder()
    .setCustomId('verify_start')
    .setLabel(buttonText)
    .setEmoji(Emoji.Bag)
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

  await interaction.reply({
    content: `${E.Assistant} Verify message posted. Use the command options (title, description, button_text, color, image_url) to customize it anytime.`,
    flags: MessageFlags.Ephemeral,
  });

  const channel = interaction.channel;
  if (channel && 'send' in channel) {
    await channel.send({
      embeds: [embed],
      components: [row],
    });
  }
}

export function buildLicenseModal(tenantId: Id<'tenants'>): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${VERIFY_PREFIX}license_modal:${tenantId}`)
    .setTitle('Enter License Key')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('license_key')
          .setLabel('License Key')
          .setPlaceholder('Paste your Gumroad or Jinxxy license key here')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500),
      ),
    );
}

export async function handleLicenseModalSubmit(
  interaction: ModalSubmitInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  apiBaseUrl: string | undefined,
): Promise<void> {
  const customId = interaction.customId;
  if (!customId.startsWith(`${VERIFY_PREFIX}license_modal:`)) return;

  const tenantId = customId.slice(`${VERIFY_PREFIX}license_modal:`.length) as Id<'tenants'>;
  const licenseKey = interaction.fields.getTextInputValue('license_key')?.trim();

  if (!licenseKey) {
    await interaction.reply({
      content: 'License key is required.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const subjectResult = await convex.query(api.subjects.getSubjectByDiscordId as any, {
    discordUserId: interaction.user.id,
  });

  let subjectId: string;
  if (subjectResult.found) {
    subjectId = subjectResult.subject._id;
  } else {
    const created = await convex.mutation(api.subjects.ensureSubjectForDiscord as any, {
      apiSecret,
      discordUserId: interaction.user.id,
      displayName: interaction.user.username,
      avatarUrl: interaction.user.displayAvatarURL({ size: 128 }),
    });
    subjectId = created.subjectId as string;
  }

  if (!apiBaseUrl) {
    await interaction.reply({
      content: 'Verification API not configured. Please contact the server admin.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const res = await fetch(`${apiBaseUrl}/api/verification/complete-license`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey, tenantId, subjectId }),
    });
    const result = (await res.json()) as {
      success?: boolean;
      error?: string;
      entitlementIds?: string[];
      provider?: string;
    };

    if (!result.success) {
      await interaction.editReply({
        content: `❌ We couldn't find a matching purchase. Make sure you're using the license key from your purchase confirmation.\n\n${result.error ?? 'Verification failed.'}`,
      });
      track(interaction.user.id, 'verification_failed', { error: result.error, tenantId });
      return;
    }

    track(interaction.user.id, 'verification_completed', { tenantId, provider: result.provider });

    await interaction.editReply({
      content:
        '🎉 **Verified!** Your roles will be updated shortly.\n\nWelcome to the community!',
    });
  } catch (err) {
    await interaction.editReply({
      content: `An error occurred during verification. Please try again.\n\`${err instanceof Error ? err.message : 'Unknown error'}\``,
    });
  }
}

export async function handleVerifyDisconnectButton(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  apiBaseUrl: string | undefined,
  provider: string,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (!apiBaseUrl) {
    await interaction.reply({
      content: 'Verification API not configured.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const subjectResult = await convex.query(api.subjects.getSubjectByDiscordId as any, {
      discordUserId: interaction.user.id,
    });

    if (!subjectResult.found) {
      await interaction.editReply({ content: 'No linked accounts found.' });
      return;
    }

    const guildLink = await convex.query(api.guildLinks.getByDiscordGuildForBot as any, {
      apiSecret,
      discordGuildId: guildId,
    });

    if (!guildLink) {
      await interaction.editReply({ content: 'Server not configured.' });
      return;
    }

    const res = await fetch(`${apiBaseUrl}/api/verification/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subjectId: subjectResult.subject._id,
        tenantId: guildLink.tenantId,
        provider,
      }),
    });

    const result = (await res.json()) as { success?: boolean; error?: string };

    if (!result.success) {
      await interaction.editReply({
        content: result.error ?? 'Failed to disconnect account.',
      });
      return;
    }

    track(interaction.user.id, 'verification_disconnected', {
      tenantId: guildLink.tenantId,
      provider,
    });

    // Refresh and show the updated panel so user sees products/accounts cleared
    const data = await fetchVerifyData(interaction.user.id, guildLink.tenantId, convex);
    const container = buildStatusContainer(
      data,
      guildLink.tenantId,
      guildId,
      apiBaseUrl,
      interaction.user.id,
    );
    await interaction.editReply({
      content: `✅ Disconnected your ${providerLabel(provider)} account. Existing roles may take a moment to be removed.`,
      flags: MessageFlags.IsComponentsV2,
      components: [container],
    });
  } catch (err) {
    await interaction.editReply({
      content: `Error disconnecting: ${err instanceof Error ? err.message : 'Unknown error'}`,
    });
  }
}
