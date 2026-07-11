/**
 * /creator-admin analytics - Analytics link and key metrics (admin)
 *
 * Single command combining link and summary.
 */

import type { ConvexHttpClient } from 'convex/browser';
import type { ChatInputCommandInteraction } from 'discord.js';
import { EmbedBuilder, MessageFlags } from 'discord.js';
import { api } from '../../../../convex/_generated/api';
import { getRequiredBotActorBinding } from '../lib/convexActor';
import { E } from '../lib/emojis';

const POSTHOG_DASHBOARD_URL = 'https://us.posthog.com';

/** /creator-admin analytics - combined dashboard link + key metrics */
export async function handleAnalytics(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { authUserId: string; guildId: string }
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const actor = await getRequiredBotActorBinding();

  const stats = await convex.query(api.entitlements.getStatsOverview, {
    actor,
    apiSecret,
    authUserId: ctx.authUserId,
  });

  const embed = new EmbedBuilder()
    .setTitle(`${E.Library} Analytics`)
    .setColor(0x5865f2)
    .setDescription(
      `[View full analytics in PostHog ↗](${POSTHOG_DASHBOARD_URL})\n\nEvents tracked: \`command_used\`, \`verification_started\`, \`verification_completed\`, \`verification_failed\`, \`spawn_button_clicked\`, \`product_added\`, \`suspicious_marked\``
    )
    .addFields(
      { name: 'Verified Users', value: String(stats.totalVerified), inline: true },
      { name: 'Products', value: String(stats.totalProducts ?? '-'), inline: true },
      { name: 'Verified (24h)', value: String(stats.recentGrantsCount), inline: true }
    );

  await interaction.editReply({ embeds: [embed] });
}
