/**
 * /creator verify-spawn - Spawn verify button
 * Verify button interaction - Gumroad OAuth or license key
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type {
  ChatInputCommandInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
} from 'discord.js';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../../convex/_generated/api';
import { track } from '../lib/posthog';

const VERIFY_PREFIX = 'creator_verify:';

export async function handleVerifySpawn(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiBaseUrl: string | undefined,
  ctx: { tenantId: Id<'tenants'>; guildLinkId: Id<'guild_links'>; guildId: string },
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

export async function handleVerifyStartButton(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  apiBaseUrl: string | undefined,
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  track(interaction.user.id, 'spawn_button_clicked', {
    guildId: ctx.guildId,
    userId: interaction.user.id,
  });

  const returnTo = `https://discord.com/channels/${ctx.guildId}`;
  const redirectUri = apiBaseUrl
    ? `${apiBaseUrl}/verify-success?returnTo=${encodeURIComponent(returnTo)}`
    : '';
  const gumroadParams = new URLSearchParams({
    tenantId: ctx.tenantId,
    mode: 'gumroad',
    redirectUri,
    discordUserId: interaction.user.id,
  });
  const gumroadUrl = apiBaseUrl
    ? `${apiBaseUrl}/api/verification/begin?${gumroadParams.toString()}`
    : null;
  const discordRoleUrl = apiBaseUrl
    ? `${apiBaseUrl}/api/verification/begin?tenantId=${ctx.tenantId}&mode=discord_role&redirectUri=${encodeURIComponent(redirectUri)}`
    : null;

  const gumroadButton = new ButtonBuilder()
    .setLabel('Sign in with Gumroad')
    .setStyle(ButtonStyle.Link)
    .setURL(gumroadUrl ?? 'https://gumroad.com');
  if (!gumroadUrl) gumroadButton.setDisabled(true);

  const discordRoleButton = new ButtonBuilder()
    .setLabel('Sign in with Discord (other server)')
    .setStyle(ButtonStyle.Link)
    .setURL(discordRoleUrl ?? 'https://discord.com');
  if (!discordRoleUrl) discordRoleButton.setDisabled(true);

  const licenseButton = new ButtonBuilder()
    .setCustomId(`${VERIFY_PREFIX}license:${ctx.tenantId}`)
    .setLabel('Verify with license key')
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...(gumroadUrl ? [gumroadButton] : []),
    ...(discordRoleUrl ? [discordRoleButton] : []),
    licenseButton,
  );

  await interaction.reply({
    content: 'Choose how to verify:',
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
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
          .setPlaceholder('Paste your Gumroad or Jinxxy license key')
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
  if (!customId.startsWith(VERIFY_PREFIX + 'license_modal:')) return;

  const tenantId = customId.slice((VERIFY_PREFIX + 'license_modal:').length) as Id<'tenants'>;
  const licenseKey = interaction.fields.getTextInputValue('license_key')?.trim();

  if (!licenseKey) {
    await interaction.reply({ content: 'License key is required.', flags: MessageFlags.Ephemeral });
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
      body: JSON.stringify({
        licenseKey,
        tenantId,
        subjectId,
      }),
    });
    const result = (await res.json()) as { success?: boolean; error?: string; entitlementIds?: string[] };

    if (!result.success) {
      await interaction.editReply({
        content: result.error ?? 'Verification failed.',
      });
      track(interaction.user.id, 'verification_failed', {
        error: result.error,
        tenantId,
      });
      return;
    }

    track(interaction.user.id, 'verification_completed', {
      tenantId,
      provider: (result as { provider?: string }).provider,
    });

    await interaction.editReply({
      content: `Verification successful! Your roles will be updated shortly.`,
    });
  } catch (err) {
    await interaction.editReply({
      content: `Error: ${err instanceof Error ? err.message : 'Verification failed'}`,
    });
  }
}
