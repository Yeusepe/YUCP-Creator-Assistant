/**
 * /creator-admin settings cross-server - Cross-server role verification settings
 *
 * Shows current status with enable/disable buttons.
 * Button handlers for enable/disable are routed in interactions.ts.
 */

import type { ConvexHttpClient } from 'convex/browser';
import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { api } from '../../../../convex/_generated/api';
import { E } from '../lib/emojis';

/** /creator-admin settings cross-server - shows status + enable/disable buttons */
export async function handleDiscordRoleVerification(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { authUserId: string }
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const tenant = await convex.query(api.creatorProfiles.getCreatorProfile, {
    apiSecret,
    authUserId: ctx.authUserId,
  });

  if (!tenant) {
    await interaction.editReply({ content: 'Tenant not found.' });
    return;
  }

  const policy = tenant.policy ?? {};
  const enabled = policy.enableDiscordRoleFromOtherServers === true;
  const allowedGuilds = (policy.allowedSourceGuildIds as string[]) ?? [];

  const embed = new EmbedBuilder()
    .setTitle('Cross-Server Role Verification')
    .setColor(enabled ? 0x57f287 : 0xed4245)
    .setDescription(
      enabled
        ? 'Users can verify by signing in with Discord and proving they have a role in an allowed source server.'
        : 'Cross-server role verification is currently disabled.'
    )
    .addFields(
      {
        name: 'Status',
        value: enabled ? `${E.Checkmark} Enabled` : `${E.X_} Disabled`,
        inline: true,
      },
      {
        name: 'Allowed Source Servers',
        value:
          allowedGuilds.length > 0
            ? allowedGuilds.map((id) => `\`${id}\``).join(', ')
            : 'None configured',
        inline: false,
      }
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`creator_settings:${enabled ? 'disable' : 'enable'}:${ctx.authUserId}`)
      .setLabel(enabled ? 'Disable' : 'Enable')
      .setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success)
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

/** Button: enable cross-server role verification */
export async function handleSettingsEnable(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  authUserId: string
): Promise<void> {
  await interaction.deferUpdate();

  await convex.mutation(api.creatorProfiles.updateCreatorPolicy, {
    apiSecret,
    authUserId,
    policy: { enableDiscordRoleFromOtherServers: true },
  });

  const embed = new EmbedBuilder()
    .setTitle('Cross-Server Role Verification')
    .setColor(0x57f287)
    .setDescription(
      `${E.Checkmark} Cross-server role verification has been **enabled**.\n\nMake sure \`allowedSourceGuildIds\` is configured in your setup (the server IDs where users must have the required role).`
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`creator_settings:disable:${authUserId}`)
      .setLabel('Disable')
      .setStyle(ButtonStyle.Danger)
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

/** Button: disable cross-server role verification */
export async function handleSettingsDisable(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  authUserId: string
): Promise<void> {
  await interaction.deferUpdate();

  await convex.mutation(api.creatorProfiles.updateCreatorPolicy, {
    apiSecret,
    authUserId,
    policy: { enableDiscordRoleFromOtherServers: false },
  });

  const embed = new EmbedBuilder()
    .setTitle('Cross-Server Role Verification')
    .setColor(0xed4245)
    .setDescription(`${E.X_} Cross-server role verification has been **disabled**.`);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`creator_settings:enable:${authUserId}`)
      .setLabel('Enable')
      .setStyle(ButtonStyle.Success)
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}
