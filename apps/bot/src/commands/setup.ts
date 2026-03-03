/**
 * /creator setup - Onboarding wizard
 *
 * Multi-step flow: logs, verification scope, share, duplicate, suspicious,
 * Discord role from other servers, Jinxxy API key.
 * Uses select menus and modals. Applies chunking (few choices per step).
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type ChannelSelectMenuInteraction,
  type StringSelectMenuInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { ChannelType } from 'discord.js';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../../convex/_generated/api';
import { track } from '../lib/posthog';

const SETUP_PREFIX = 'creator_setup:';

export interface SetupContext {
  tenantId: Id<'tenants'>;
  guildLinkId: Id<'guild_links'>;
  guildId: string;
}

export async function runSetupStart(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: SetupContext,
): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle('Creator Setup — Step 1 of 3')
    .setDescription(
      'Configure your verification settings. Select an option for each setting below.',
    )
    .setColor(0x5865f2)
    .addFields({
      name: 'Progress',
      value: 'Step 1: Core settings',
      inline: false,
    });

  const verificationScopeSelect = new StringSelectMenuBuilder()
    .setCustomId(`${SETUP_PREFIX}verification_scope:${ctx.tenantId}`)
    .setPlaceholder('Verification scope')
    .addOptions(
      { label: 'Verify whole account (all purchases)', value: 'account' },
      { label: 'Verify specific licenses only', value: 'license' },
    );

  const shareSelect = new StringSelectMenuBuilder()
    .setCustomId(`${SETUP_PREFIX}share:${ctx.tenantId}`)
    .setPlaceholder('Share verification with other servers?')
    .addOptions(
      { label: 'Yes', value: 'true', description: 'Other servers can see entitlement status' },
      { label: 'No', value: 'false' },
    );

  const duplicateSelect = new StringSelectMenuBuilder()
    .setCustomId(`${SETUP_PREFIX}duplicate:${ctx.tenantId}`)
    .setPlaceholder('Duplicate verification (same product twice)')
    .addOptions(
      { label: 'Block', value: 'block' },
      { label: 'Notify me', value: 'notify' },
      { label: 'Allow', value: 'allow' },
    );

  const suspiciousSelect = new StringSelectMenuBuilder()
    .setCustomId(`${SETUP_PREFIX}suspicious:${ctx.tenantId}`)
    .setPlaceholder('Suspicious account behavior')
    .addOptions(
      { label: 'Quarantine', value: 'quarantine' },
      { label: 'Notify me', value: 'notify' },
      { label: 'Revoke access', value: 'revoke' },
    );

  const row1 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    verificationScopeSelect,
  );
  const row2 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(shareSelect);
  const row3 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(duplicateSelect);
  const row4 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(suspiciousSelect);
  const row5 = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`${SETUP_PREFIX}next:${ctx.tenantId}`)
        .setLabel('Next: Logs & Jinxxy')
        .setStyle(ButtonStyle.Primary),
    );

  await interaction.reply({
    embeds: [embed],
    components: [row1, row2, row3, row4, row5],
    flags: MessageFlags.Ephemeral,
  });

  track(interaction.user.id, 'setup_started', {
    tenantId: ctx.tenantId,
    guildId: ctx.guildId,
  });
}

export async function handleSetupSelect(
  interaction: StringSelectMenuInteraction | ChannelSelectMenuInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
): Promise<void> {
  const customId = interaction.customId;
  if (!customId.startsWith(SETUP_PREFIX)) return;

  const parts = customId.slice(SETUP_PREFIX.length).split(':');
  const field = parts[0];
  const tenantId = parts[1] as Id<'tenants'>;
  if (!tenantId) return;

  let value: string | string[] | undefined;
  if (interaction.isChannelSelectMenu()) {
    const channel = interaction.channels.first();
    value = channel?.id ?? undefined;
  } else {
    value = interaction.values[0];
  }

  if (!value) {
    await interaction.reply({ content: 'No value selected.', flags: MessageFlags.Ephemeral });
    return;
  }

  const policy: Record<string, unknown> = {};
  if (field === 'verification_scope') {
    policy.verificationScope = value as 'account' | 'license';
  } else if (field === 'share') {
    policy.shareVerificationWithServers = value === 'true';
    policy.shareVerificationScope = 'entitlements_only';
  } else if (field === 'duplicate') {
    policy.duplicateVerificationBehavior = value as 'block' | 'notify' | 'allow';
  } else if (field === 'suspicious') {
    policy.suspiciousAccountBehavior = value as 'quarantine' | 'notify' | 'revoke';
  } else if (field === 'log_channel') {
    policy.logChannelId = value as string;
  } else if (field === 'discord_role_other') {
    policy.enableDiscordRoleFromOtherServers = value === 'true';
  } else if (field === 'source_guilds') {
    policy.allowedSourceGuildIds = Array.isArray(value) ? value : [value];
  }

  await convex.mutation(api.tenants.updateTenantPolicy as any, {
    apiSecret,
    tenantId,
    policy,
  });

  await interaction.reply({
    content: `Updated: ${field.replace(/_/g, ' ')}`,
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleSetupJinxxyModal(
  interaction: ModalSubmitInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
): Promise<void> {
  const customId = interaction.customId;
  if (!customId.startsWith(SETUP_PREFIX + 'jinxxy:')) return;

  const tenantId = customId.slice((SETUP_PREFIX + 'jinxxy:').length) as Id<'tenants'>;
  const apiKey = interaction.fields.getTextInputValue('jinxxy_api_key');

  if (!apiKey?.trim()) {
    await interaction.reply({
      content: 'API key cannot be empty.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // TODO: Encrypt before storing. For now store as-is (bot has no encryption keys).
  await convex.mutation(api.tenants.upsertJinxxyApiKey as any, {
    apiSecret,
    tenantId,
    jinxxyApiKeyEncrypted: apiKey.trim(),
  });

  await interaction.reply({
    content: 'Jinxxy API key saved. You can verify Jinxxy products now.',
    flags: MessageFlags.Ephemeral,
  });

  track(interaction.user.id, 'setup_jinxxy_configured', {
    tenantId,
    guildId: interaction.guildId,
  });
}

export function buildSetupStep2Components(tenantId: Id<'tenants'>) {
  const logChannelSelect = new ChannelSelectMenuBuilder()
    .setCustomId(`${SETUP_PREFIX}log_channel:${tenantId}`)
    .setPlaceholder('Select log channel (or skip)')
    .setChannelTypes(ChannelType.GuildText)
    .setMaxValues(1)
    .setMinValues(0);

  const jinxxyButton = new ButtonBuilder()
    .setCustomId(`${SETUP_PREFIX}jinxxy_btn:${tenantId}`)
    .setLabel('Set Jinxxy API Key')
    .setStyle(ButtonStyle.Secondary);

  return { logChannelSelect, jinxxyButton };
}

export function buildJinxxyModal(tenantId: Id<'tenants'>): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${SETUP_PREFIX}jinxxy:${tenantId}`)
    .setTitle('Jinxxy API Key')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('jinxxy_api_key')
          .setLabel('API Key')
          .setPlaceholder('Your Jinxxy x-api-key')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(256),
      ),
    );
}
