/**
 * /creator stats - Verification statistics
 *
 * overview: Total verified, products, recent activity
 * verified: List verified users (paginated)
 * products: Product verification counts
 * user: User-specific verification status
 */

import { EmbedBuilder, MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../../convex/_generated/api';

export async function handleStatsOverview(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const rules = await convex.query(api.role_rules.getByGuild as any, {
    tenantId: ctx.tenantId,
    guildId: ctx.guildId,
  });
  const stats = await convex.query(api.entitlements.getStatsOverview as any, {
    tenantId: ctx.tenantId,
  });

  const embed = new EmbedBuilder()
    .setTitle('YUCP Stats Overview')
    .setColor(0x5865f2)
    .addFields(
      { name: 'Verified users', value: String(stats.totalVerified), inline: true },
      { name: 'Products configured', value: String(rules.length), inline: true },
      { name: 'Verifications (24h)', value: String(stats.recentGrantsCount), inline: true },
    );

  await interaction.editReply({ embeds: [embed] });
}

export async function handleStatsVerified(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { users } = await convex.query(api.entitlements.getVerifiedUsersPaginated as any, {
    tenantId: ctx.tenantId,
    limit: 25,
  });

  if (!users.length) {
    await interaction.editReply({ content: 'No verified users.' });
    return;
  }

  const lines = users.map(
    (u: { discordUserId: string; displayName?: string; productCount: number }) =>
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
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const productStats = await convex.query(api.entitlements.getProductStats as any, {
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
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  const targetUser = interaction.options.getUser('user', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const subjectResult = await convex.query(api.subjects.getSubjectByDiscordId as any, {
    discordUserId: targetUser.id,
  });
  if (!subjectResult.found) {
    await interaction.editReply({
      content: `No account found for <@${targetUser.id}>.`,
    });
    return;
  }

  const entitlements = await convex.query(api.entitlements.getEntitlementsBySubject as any, {
    tenantId: ctx.tenantId,
    subjectId: subjectResult.subject._id,
    includeInactive: false,
  });

  const productIds = [...new Set(entitlements.map((e: { productId: string }) => e.productId))];
  const status = productIds.length ? 'Verified ✓' : 'No active products';
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
