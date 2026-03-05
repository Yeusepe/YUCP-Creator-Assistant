/**
 * /creator-admin moderation — Suspicious account management (admin)
 *
 * mark: Flag user (shows reason select menu)
 * list: List flagged accounts
 * clear: Clear flag (shows confirmation first)
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../../convex/_generated/api';
import { Emoji } from '../lib/emojis';
import { track } from '../lib/posthog';

/** /creator-admin moderation mark @user — shows reason select menu */
export async function handleModerationMark(
  interaction: ChatInputCommandInteraction,
  _convex: ConvexHttpClient,
  _apiSecret: string,
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  const targetUser = interaction.options.getUser('user', true);

  const select = new StringSelectMenuBuilder()
    .setCustomId(
      `creator_moderation:reason_select:${interaction.user.id}:${ctx.tenantId}:${targetUser.id}`,
    )
    .setPlaceholder('Select a reason...')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('Duplicate license')
        .setDescription('Using the same license key on multiple accounts')
        .setValue('Duplicate license')
        .setEmoji(Emoji.Refresh),
      new StringSelectMenuOptionBuilder()
        .setLabel('Chargebacks')
        .setDescription('Reversed payment after receiving access')
        .setValue('Chargebacks')
        .setEmoji(Emoji.CreditCard),
      new StringSelectMenuOptionBuilder()
        .setLabel('Piracy')
        .setDescription('Using pirated or stolen license key')
        .setValue('Piracy')
        .setEmoji('🏴‍☠️'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Other')
        .setDescription('Other reason (add details in audit log)')
        .setValue('Other')
        .setEmoji(Emoji.Wrench),
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

  await interaction.reply({
    content: `Flag <@${targetUser.id}> as suspicious. Select a reason:`,
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

/** Select menu: reason selected — perform the flag */
export async function handleModerationReasonSelect(
  interaction: StringSelectMenuInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  actorId: string,
  tenantId: Id<'tenants'>,
  targetUserId: string,
): Promise<void> {
  const reason = interaction.values[0];
  await interaction.deferUpdate();

  const subjectResult = await convex.query(api.subjects.getSubjectByDiscordId as any, {
    discordUserId: targetUserId,
  });

  if (!subjectResult.found) {
    await interaction.editReply({
      content: `No account found for <@${targetUserId}>. They may not have verified yet.`,
      components: [],
    });
    return;
  }

  const result = await convex.mutation(api.identitySync.markSubjectSuspicious as any, {
    apiSecret,
    subjectId: subjectResult.subject._id,
    reason,
    actorId,
    tenantId,
    quarantine: true,
  });

  track(actorId, 'suspicious_marked', {
    tenantId,
    subjectId: subjectResult.subject._id,
    targetUserId,
    reason,
  });

  const alreadyFlagged = (result as { wasAlreadySuspicious?: boolean }).wasAlreadySuspicious;

  const embed = new EmbedBuilder()
    .setTitle('User Flagged')
    .setColor(0xed4245)
    .setDescription(
      `<@${targetUserId}> has been flagged as suspicious${alreadyFlagged ? ' (was already flagged)' : ''}.\n**Reason:** ${reason}`,
    );

  await interaction.editReply({ embeds: [embed], components: [] });
}

/** /creator-admin moderation list — shows flagged accounts */
export async function handleModerationList(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const list = await convex.query(api.identitySync.listSuspiciousSubjects as any, {
    apiSecret,
    tenantId: ctx.tenantId,
    limit: 25,
  });

  if (!list.length) {
    await interaction.editReply({ content: 'No flagged accounts.' });
    return;
  }

  const lines = list.map(
    (s: { discordUserId: string; reason?: string; _creationTime?: number }) => {
      const date = s._creationTime
        ? `<t:${Math.floor(s._creationTime / 1000)}:d>`
        : '';
      return `<@${s.discordUserId}> — **${s.reason ?? 'No reason'}** ${date}`;
    },
  );

  const embed = new EmbedBuilder()
    .setTitle('Flagged Accounts')
    .setColor(0xed4245)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Showing up to 25 accounts` });

  await interaction.editReply({ embeds: [embed] });
}

/** /creator-admin moderation clear @user — shows confirmation */
export async function handleModerationClear(
  interaction: ChatInputCommandInteraction,
  _convex: ConvexHttpClient,
  _apiSecret: string,
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  const targetUser = interaction.options.getUser('user', true);

  const embed = new EmbedBuilder()
    .setTitle('Clear Suspicious Flag?')
    .setColor(0xfaa61a)
    .setDescription(
      `Are you sure you want to clear the suspicious flag for <@${targetUser.id}>?\nThis will allow them to use the server normally again.`,
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(
        `creator_moderation:confirm_clear:${targetUser.id}:${ctx.tenantId}:${interaction.user.id}`,
      )
      .setLabel('Yes, Clear Flag')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('creator_moderation:cancel_clear')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({
    embeds: [embed],
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

/** Confirm clear button — actually clears the flag */
export async function handleModerationConfirmClear(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  targetUserId: string,
  tenantId: Id<'tenants'>,
  actorId: string,
): Promise<void> {
  await interaction.deferUpdate();

  const subjectResult = await convex.query(api.subjects.getSubjectByDiscordId as any, {
    discordUserId: targetUserId,
  });

  if (!subjectResult.found) {
    await interaction.editReply({
      content: `No account found for <@${targetUserId}>.`,
      components: [],
      embeds: [],
    });
    return;
  }

  await convex.mutation(api.identitySync.clearSubjectSuspicious as any, {
    apiSecret,
    subjectId: subjectResult.subject._id,
    actorId,
    tenantId,
  });

  const embed = new EmbedBuilder()
    .setTitle('Flag Cleared')
    .setColor(0x57f287)
    .setDescription(`The suspicious flag for <@${targetUserId}> has been cleared.`);

  await interaction.editReply({ embeds: [embed], components: [] });
}

// ─── Unverify command ────────────────────────────────────────────────────────

/** /creator-admin moderation unverify @user product_id — removes a verified product */
export async function handleModerationUnverify(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  const targetUser = interaction.options.getUser('user', true);
  const productId = interaction.options.getString('product_id', true);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const result = await convex.mutation(api.entitlements.revokeEntitlementsByProduct as any, {
      apiSecret,
      tenantId: ctx.tenantId,
      discordUserId: targetUser.id,
      productId,
    });

    const productsWithNames = await convex.query(api.role_rules.getByGuildWithProductNames as any, {
      tenantId: ctx.tenantId,
      guildId: ctx.guildId,
    });
    const productDisplayName =
      productsWithNames.find((p: { productId: string; displayName: string | null }) => p.productId === productId)
        ?.displayName ?? productId;

    if (!result.success) {
      const reasonMap: Record<string, string> = {
        not_found: `User <@${targetUser.id}> does not seem to have any verified accounts.`,
        no_active_entitlements: `User <@${targetUser.id}> does not have an active verification for **${productDisplayName}**.`,
      };
      const text = reasonMap[result.reason ?? ''] ?? 'Could not remove verification.';

      const embed = new EmbedBuilder()
        .setTitle('No Action Taken')
        .setColor(0xfaa61a)
        .setDescription(text);

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('Verification Removed')
      .setColor(0xed4245)
      .setDescription(
        `Successfully removed **${productDisplayName}** verification from <@${targetUser.id}>.\nAny associated Discord roles are being automatically removed in the background.`,
      );

    await interaction.editReply({ embeds: [embed] });

    track(interaction.user.id, 'moderation_unverify_used', {
      tenantId: ctx.tenantId,
      targetUserId: targetUser.id,
      productId,
      revokedCount: result.revokedCount,
    });
  } catch (err) {
    await interaction.editReply({
      content: `Failed to remove verification.\n\`${err instanceof Error ? err.message : 'Unknown error'}\``,
    });
  }
}


// ─── Backward-compat exports (used by old suspicious group routing in interactions.ts) ───

export async function handleSuspiciousMark(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  return handleModerationMark(interaction, convex, apiSecret, ctx);
}

export async function handleSuspiciousList(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  return handleModerationList(interaction, convex, apiSecret, ctx);
}

export async function handleSuspiciousClear(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  return handleModerationClear(interaction, convex, apiSecret, ctx);
}
