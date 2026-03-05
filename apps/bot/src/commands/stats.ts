/**
 * /creator-admin stats — Verification statistics with navigation buttons
 *
 * Single command shows overview. Navigation buttons open sub-views.
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
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
} from 'discord.js';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../../convex/_generated/api';
import { E } from '../lib/emojis';

/** /creator-admin stats — shows overview with navigation buttons */
export async function handleStats(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const rules = await convex.query(api.role_rules.getByGuild as any, {
    tenantId: ctx.tenantId,
    guildId: ctx.guildId,
  });
  const stats = await convex.query(api.entitlements.getStatsOverview as any, {
    apiSecret,
    tenantId: ctx.tenantId,
  });

  const embed = new EmbedBuilder()
    .setTitle(`${E.Library} Verification Stats`)
    .setColor(0x5865f2)
    .addFields(
      { name: 'Verified Users', value: String(stats.totalVerified), inline: true },
      { name: 'Products Mapped', value: String(rules.length), inline: true },
      { name: 'Verified (24h)', value: String(stats.recentGrantsCount), inline: true },
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`creator_stats:view_users:${ctx.tenantId}`)
      .setLabel('View Users')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`creator_stats:view_products:${ctx.tenantId}`)
      .setLabel('View Products')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`creator_stats:check_user:${ctx.tenantId}`)
      .setLabel('Check a User')
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

/** Button: View Users — shows paginated verified users list */
export async function handleStatsViewUsersButton(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  tenantId: Id<'tenants'>,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { users } = await convex.query(api.entitlements.getVerifiedUsersPaginated as any, {
    apiSecret,
    tenantId,
    limit: 25,
  });

  if (!users.length) {
    await interaction.editReply({ content: 'No verified users yet.' });
    return;
  }

  const lines = users.map(
    (u: { discordUserId: string; productCount: number }) =>
      `<@${u.discordUserId}> — ${u.productCount} product(s)`,
  );

  const embed = new EmbedBuilder()
    .setTitle('Verified Users')
    .setColor(0x5865f2)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Showing up to 25 users` });

  await interaction.editReply({ embeds: [embed] });
}

/** Button: View Products — shows product verification counts */
export async function handleStatsViewProductsButton(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  tenantId: Id<'tenants'>,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const productStats = await convex.query(api.entitlements.getProductStats as any, {
    apiSecret,
    tenantId,
  });

  if (!productStats.length) {
    await interaction.editReply({ content: 'No product verification data yet.' });
    return;
  }

  const lines = productStats
    .sort(
      (a: { verifiedCount: number }, b: { verifiedCount: number }) =>
        b.verifiedCount - a.verifiedCount,
    )
    .map((p: { productId: string; verifiedCount: number }) => `• \`${p.productId}\`: ${p.verifiedCount}`);

  const embed = new EmbedBuilder()
    .setTitle('Product Verification Counts')
    .setColor(0x5865f2)
    .setDescription(lines.join('\n'));

  await interaction.editReply({ embeds: [embed] });
}

/** Button: Check a User — shows modal to enter user ID */
export async function handleStatsCheckUserButton(
  interaction: ButtonInteraction,
  tenantId: Id<'tenants'>,
): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`creator_stats:check_user_modal:${tenantId}`)
    .setTitle('Check User Verification')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('discord_user_id')
          .setLabel('Discord User ID')
          .setPlaceholder('Right-click the user → Copy User ID (requires Developer Mode)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(17)
          .setMaxLength(20),
      ),
    );

  await interaction.showModal(modal);
}

/** Modal: Check user verification status */
export async function handleStatsCheckUserModal(
  interaction: ModalSubmitInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  tenantId: Id<'tenants'>,
): Promise<void> {
  const discordUserId = interaction.fields.getTextInputValue('discord_user_id')?.trim();

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const subjectResult = await convex.query(api.subjects.getSubjectByDiscordId as any, {
    discordUserId,
  });

  if (!subjectResult.found) {
    await interaction.editReply({
      content: `No account found for user ID \`${discordUserId}\`. They may not have verified yet.`,
    });
    return;
  }

  const entitlements = await convex.query(api.entitlements.getEntitlementsBySubject as any, {
    apiSecret,
    tenantId,
    subjectId: subjectResult.subject._id,
    includeInactive: false,
  });

  const productIds = [...new Set(entitlements.map((e: { productId: string }) => e.productId))];
  const status = productIds.length ? `Verified ${E.Checkmark}` : 'No active products';

  const embed = new EmbedBuilder()
    .setTitle(`Verification: <@${discordUserId}>`)
    .setColor(0x5865f2)
    .addFields(
      { name: 'Status', value: status, inline: false },
      {
        name: 'Products',
        value: productIds.length ? productIds.map((p) => `\`${p}\``).join(', ') : 'None',
        inline: false,
      },
    );

  await interaction.editReply({ embeds: [embed] });
}

// Legacy named exports kept for any existing references
export async function handleStatsOverview(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  return handleStats(interaction, convex, apiSecret, ctx);
}

export async function handleStatsVerified(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { users } = await convex.query(api.entitlements.getVerifiedUsersPaginated as any, {
    apiSecret,
    tenantId: ctx.tenantId,
    limit: 25,
  });
  if (!users.length) {
    await interaction.editReply({ content: 'No verified users.' });
    return;
  }
  const lines = users.map(
    (u: { discordUserId: string; productCount: number }) =>
      `<@${u.discordUserId}> — ${u.productCount} product(s)`,
  );
  const embed = new EmbedBuilder()
    .setTitle('Verified Users')
    .setColor(0x5865f2)
    .setDescription(lines.join('\n'));
  await interaction.editReply({ embeds: [embed] });
}

export async function handleStatsProducts(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const productStats = await convex.query(api.entitlements.getProductStats as any, {
    apiSecret,
    tenantId: ctx.tenantId,
  });
  if (!productStats.length) {
    await interaction.editReply({ content: 'No product verification data.' });
    return;
  }
  const lines = productStats
    .sort((a: { verifiedCount: number }, b: { verifiedCount: number }) => b.verifiedCount - a.verifiedCount)
    .map((p: { productId: string; verifiedCount: number }) => `• \`${p.productId}\`: ${p.verifiedCount}`);
  const embed = new EmbedBuilder()
    .setTitle('Product Verification Counts')
    .setColor(0x5865f2)
    .setDescription(lines.join('\n'));
  await interaction.editReply({ embeds: [embed] });
}

export async function handleStatsUser(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  const targetUser = interaction.options.getUser('user', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const subjectResult = await convex.query(api.subjects.getSubjectByDiscordId as any, {
    discordUserId: targetUser.id,
  });
  if (!subjectResult.found) {
    await interaction.editReply({ content: `No account found for <@${targetUser.id}>.` });
    return;
  }
  const entitlements = await convex.query(api.entitlements.getEntitlementsBySubject as any, {
    apiSecret,
    tenantId: ctx.tenantId,
    subjectId: subjectResult.subject._id,
    includeInactive: false,
  });
  const productIds = [...new Set(entitlements.map((e: { productId: string }) => e.productId))];
  const status = productIds.length ? `Verified ${E.Checkmark}` : 'No active products';
  const embed = new EmbedBuilder()
    .setTitle(`Verification: ${targetUser.username}`)
    .setColor(0x5865f2)
    .addFields(
      { name: 'Status', value: status, inline: false },
      {
        name: 'Products',
        value: productIds.length ? productIds.map((p) => `\`${p}\``).join(', ') : 'None',
        inline: false,
      },
    );
  await interaction.editReply({ embeds: [embed] });
}
