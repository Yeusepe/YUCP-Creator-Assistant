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
import { track } from '../lib/posthog';

const VERIFY_PREFIX = 'creator_verify:';

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

function buildStatusContainer(
  data: VerifyData,
  tenantId: Id<'tenants'>,
  guildId: string,
  apiBaseUrl: string | undefined,
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
      new TextDisplayBuilder().setContent('## 🔐 Your Verification Status'),
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
      `**Connected Accounts**\nGumroad — ${gumroadStatus}\nDiscord (other server) — ${discordStatus}`,
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
  const gumroadUrl = apiBaseUrl
    ? `${apiBaseUrl}/api/verification/begin?${new URLSearchParams({ tenantId, mode: 'gumroad', redirectUri }).toString()}`
    : null;
  const discordRoleUrl = apiBaseUrl
    ? `${apiBaseUrl}/api/verification/begin?tenantId=${tenantId}&mode=discord_role&redirectUri=${encodeURIComponent(redirectUri)}`
    : null;

  if (state === 'nothing') {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('👇 Choose how to verify your purchase:'),
    );

    const buttons: ButtonBuilder[] = [];

    if (gumroadUrl) {
      buttons.push(
        new ButtonBuilder()
          .setLabel('🛒 Connect Gumroad')
          .setStyle(ButtonStyle.Link)
          .setURL(gumroadUrl),
      );
    }

    buttons.push(
      new ButtonBuilder()
        .setCustomId(`${VERIFY_PREFIX}license:${tenantId}`)
        .setLabel('🔑 Use License Key')
        .setStyle(ButtonStyle.Secondary),
    );

    if (discordRoleUrl) {
      buttons.push(
        new ButtonBuilder()
          .setLabel('🔗 Use Another Server')
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
          .setLabel('🛒 Connect Gumroad')
          .setStyle(ButtonStyle.Link)
          .setURL(gumroadUrl),
      );
    }

    buttons.push(
      new ButtonBuilder()
        .setCustomId(`${VERIFY_PREFIX}license:${tenantId}`)
        .setLabel('🔑 Use License Key')
        .setStyle(ButtonStyle.Secondary),
    );

    if (discordRoleUrl && !hasDiscord) {
      buttons.push(
        new ButtonBuilder()
          .setLabel('🔗 Use Another Server')
          .setStyle(ButtonStyle.Link)
          .setURL(discordRoleUrl),
      );
    }

    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(0, 3)),
    );

    // Disconnect row (separate row to keep layout clean)
    const primaryProvider = linkedAccounts.find((a) => a.status === 'active')?.provider ?? 'gumroad';
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${VERIFY_PREFIX}disconnect:${primaryProvider}`)
          .setLabel('Disconnect account')
          .setStyle(ButtonStyle.Danger),
      ),
    );
  } else {
    // Verified state
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        'You have access to this server. Use the buttons below to manage your connection.',
      ),
    );

    const primaryProvider = linkedAccounts.find((a) => a.status === 'active')?.provider ?? 'gumroad';
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${VERIFY_PREFIX}add_more:${tenantId}`)
          .setLabel('➕ Add another account')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`${VERIFY_PREFIX}disconnect:${primaryProvider}`)
          .setLabel('🔌 Remove connection')
          .setStyle(ButtonStyle.Danger),
      ),
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
    const container = buildStatusContainer(data, ctx.tenantId, ctx.guildId, apiBaseUrl);
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
    const container = buildStatusContainer(data, ctx.tenantId, ctx.guildId, apiBaseUrl);
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
  const embed = new EmbedBuilder()
    .setTitle('Verify Your Purchase')
    .setDescription('Click the button below to verify your purchase and get your role.')
    .setColor(0x5865f2);

  const button = new ButtonBuilder()
    .setCustomId('verify_start')
    .setLabel('Verify')
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

  await interaction.reply({
    content: 'Verify button created.',
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

    await interaction.editReply({
      content: `✅ Disconnected your ${provider} account. Existing roles may take a moment to be removed.`,
    });

    track(interaction.user.id, 'verification_disconnected', {
      tenantId: guildLink.tenantId,
      provider,
    });
  } catch (err) {
    await interaction.editReply({
      content: `Error disconnecting: ${err instanceof Error ? err.message : 'Unknown error'}`,
    });
  }
}
