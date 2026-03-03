/**
 * /creator discord-role-verification - Enable/disable cross-server role verification
 */

import { EmbedBuilder, MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../../convex/_generated/api';

export async function handleDiscordRoleVerification(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { tenantId: Id<'tenants'> },
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  const tenant = await convex.query(api.tenants.getTenant as any, {
    tenantId: ctx.tenantId,
  });

  if (!tenant) {
    await interaction.reply({
      content: 'Tenant not found.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const policy = tenant.policy ?? {};
  const enabled = policy.enableDiscordRoleFromOtherServers === true;
  const allowedGuilds = (policy.allowedSourceGuildIds as string[]) ?? [];

  if (subcommand === 'status') {
    const embed = new EmbedBuilder()
      .setTitle('Discord Role Verification (Other Servers)')
      .setColor(enabled ? 0x57f287 : 0xed4245)
      .addFields(
        {
          name: 'Status',
          value: enabled ? 'Enabled' : 'Disabled',
          inline: true,
        },
        {
          name: 'Allowed source guilds',
          value:
            allowedGuilds.length > 0
              ? allowedGuilds.map((id) => `\`${id}\``).join(', ')
              : 'None configured',
          inline: false,
        },
      )
      .setDescription(
        enabled
          ? 'Users can verify by signing in with Discord and proving they have a role in an allowed source server.'
          : 'Cross-server role verification is disabled. Use `enable` to turn it on.',
      );

    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === 'disable') {
    await convex.mutation(api.tenants.updateTenantPolicy as any, {
      apiSecret,
      tenantId: ctx.tenantId,
      policy: { enableDiscordRoleFromOtherServers: false },
    });
    await interaction.reply({
      content: 'Discord role verification from other servers has been **disabled**.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === 'enable') {
    await convex.mutation(api.tenants.updateTenantPolicy as any, {
      apiSecret,
      tenantId: ctx.tenantId,
      policy: { enableDiscordRoleFromOtherServers: true },
    });
    await interaction.reply({
      content:
        'Discord role verification from other servers has been **enabled**. Ensure `allowedSourceGuildIds` is configured in setup (source guild IDs where users must have the required role).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: 'Unknown subcommand.',
    flags: MessageFlags.Ephemeral,
  });
}
