/**
 * /creator analytics - Analytics link and summary (admin)
 */

import { EmbedBuilder, MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../../convex/_generated/api';

const POSTHOG_DASHBOARD_URL = 'https://us.posthog.com';

export async function handleAnalyticsLink(
  interaction: ChatInputCommandInteraction,
  _convex: ConvexHttpClient,
  _ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle('Analytics')
    .setColor(0x5865f2)
    .setDescription(
      `View full analytics in PostHog:\n${POSTHOG_DASHBOARD_URL}\n\nEvents tracked: command_used, verification_started, verification_completed, verification_failed, spawn_button_clicked, product_added, suspicious_marked`,
    );

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

export async function handleAnalyticsSummary(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const stats = await convex.query(api.entitlements.getStatsOverview as any, {
    tenantId: ctx.tenantId,
  });

  const embed = new EmbedBuilder()
    .setTitle('Analytics Summary')
    .setColor(0x5865f2)
    .addFields(
      { name: 'Verified users', value: String(stats.totalVerified), inline: true },
      { name: 'Products', value: String(stats.totalProducts), inline: true },
      { name: 'Verifications (24h)', value: String(stats.recentGrantsCount), inline: true },
    )
    .setFooter({ text: 'Full analytics in PostHog dashboard' });

  await interaction.editReply({ embeds: [embed] });
}
