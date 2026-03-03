/**
 * /creator status - Show user verification status (user command)
 */

import { EmbedBuilder, MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../../convex/_generated/api';

export async function handleStatus(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const subjectResult = await convex.query(api.subjects.getSubjectByDiscordId as any, {
    discordUserId: interaction.user.id,
  });

  if (!subjectResult.found) {
    await interaction.editReply({
      content: 'No account found. Use `/creator link` to link your account, or click the Verify button.',
    });
    return;
  }

  const entitlements = await convex.query(api.entitlements.getEntitlementsBySubject as any, {
    tenantId: ctx.tenantId,
    subjectId: subjectResult.subject._id,
    includeInactive: false,
  });

  const productIds = [...new Set(entitlements.map((e: { productId: string }) => e.productId))];
  const providerList = (entitlements as Array<{ sourceProvider?: string }>)
    .map((e) => e.sourceProvider ?? '')
    .filter((s): s is string => Boolean(s));
  const providers = [...new Set(providerList)];
  const linkedGumroad = providers.includes('gumroad');
  const linkedJinxxy = providers.includes('jinxxy');
  const linkedDiscord = true;

  const embed = new EmbedBuilder()
    .setTitle('Your Verification Status')
    .setColor(0x5865f2)
    .addFields(
      {
        name: 'Linked accounts',
        value: [
          `Gumroad: ${linkedGumroad ? '✓' : '✗'}`,
          `Jinxxy: ${linkedJinxxy ? '✓' : '✗'}`,
          `Discord: ${linkedDiscord ? '✓' : '✗'}`,
        ].join('\n'),
        inline: true,
      },
      {
        name: 'Verified products',
        value: productIds.length
          ? productIds.map((p) => `\`${p}\``).join(', ')
          : 'None',
        inline: false,
      },
    );

  await interaction.editReply({ embeds: [embed] });
}
