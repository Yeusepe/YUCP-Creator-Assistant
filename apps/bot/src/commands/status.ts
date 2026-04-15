/**
 * /creator status - Show user verification status (user command)
 */

import { PROVIDER_REGISTRY } from '@yucp/providers/providerMetadata';
import type { ProviderDescriptor } from '@yucp/providers/types';
import type { ConvexHttpClient } from 'convex/browser';
import type { ChatInputCommandInteraction } from 'discord.js';
import { EmbedBuilder, MessageFlags } from 'discord.js';
import { api } from '../../../../convex/_generated/api';
import { getRequiredBotActorBinding } from '../lib/convexActor';
import { E } from '../lib/emojis';

export async function handleStatus(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { authUserId: string; guildId: string }
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const actor = await getRequiredBotActorBinding();

  const subjectResult = await convex.query(api.subjects.getSubjectByDiscordId, {
    actor,
    apiSecret,
    discordUserId: interaction.user.id,
  });

  if (!subjectResult.found) {
    await interaction.editReply({
      content:
        'No account found. Use `/creator link` to link your account, or click the Verify button.',
    });
    return;
  }

  const entitlements = await convex.query(api.entitlements.getEntitlementsBySubject, {
    actor,
    apiSecret,
    authUserId: ctx.authUserId,
    subjectId: subjectResult.subject._id,
    includeInactive: false,
  });

  const productIds = [...new Set(entitlements.map((e: { productId: string }) => e.productId))];
  const providerList = (entitlements as Array<{ sourceProvider?: string }>)
    .map((e) => e.sourceProvider ?? '')
    .filter((s): s is string => Boolean(s));
  const providers = [...new Set(providerList)];

  const statusProviders = (PROVIDER_REGISTRY as readonly ProviderDescriptor[]).filter(
    (p) => p.status === 'active' && (p.category === 'commerce' || p.category === 'community')
  );

  const linkedAccountsValue = statusProviders
    .map((p) => {
      const emoji = E[p.emojiKey as keyof typeof E] ?? '';
      const isLinked = p.providerKey === 'discord' ? true : providers.includes(p.providerKey);
      return `${emoji} ${p.label}: ${isLinked ? E.Checkmark : E.X_}`;
    })
    .join('\n');

  const embed = new EmbedBuilder()
    .setTitle('Your Verification Status')
    .setColor(0x5865f2)
    .addFields(
      {
        name: 'Linked accounts',
        value: linkedAccountsValue,
        inline: true,
      },
      {
        name: 'Verified products',
        value: productIds.length ? productIds.map((p) => `\`${p}\``).join(', ') : 'None',
        inline: false,
      }
    );

  await interaction.editReply({ embeds: [embed] });
}
