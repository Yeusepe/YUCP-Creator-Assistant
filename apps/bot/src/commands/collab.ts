/**
 * Collaborating Creators - /creator-admin collab invite/list
 *
 * Allows a server owner to generate an invite link for a collaborator to share
 * their Jinxxy API key for cross-store license verification.
 * The collaborator's identity is verified via Discord OAuth on the consent page.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { createLogger } from '@yucp/shared';
import { E } from '../lib/emojis';
import { getApiUrls } from '../lib/apiUrls';
import type { Id } from '../../../../convex/_generated/dataModel';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

/**
 * /creator-admin collab invite
 * Immediately generates and shows an invite link that the owner can share with any creator.
 * The collaborator verifies their Discord identity via OAuth on the consent page.
 */
export async function handleCollabInvite(
  interaction: ChatInputCommandInteraction,
  apiSecret: string,
  tenantId: Id<'tenants'>,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { apiInternal, apiPublic } = getApiUrls();
  const apiBase = apiInternal ?? apiPublic;

  if (!apiBase) {
    await interaction.editReply({ content: 'API base URL not configured.' });
    return;
  }

  await generateAndShowInviteLink(
    interaction,
    apiBase,
    apiSecret,
    tenantId,
    interaction.guildId ?? '',
    interaction.guild?.name ?? 'this server',
  );
}

/**
 * /creator-admin collab list
 * Shows the list of active collaborator connections.
 */
export async function handleCollabList(
  interaction: ChatInputCommandInteraction,
  apiSecret: string,
  tenantId: Id<'tenants'>,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { apiInternal, apiPublic } = getApiUrls();
  const apiBase = apiInternal ?? apiPublic;

  if (!apiBase) {
    await interaction.editReply({ content: 'API base URL not configured.' });
    return;
  }

  // Fetch setup session token for auth
  let sessionToken: string | null = null;
  try {
    const res = await fetch(`${apiBase}/api/setup/create-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId,
        guildId: interaction.guildId ?? '',
        discordUserId: interaction.user.id,
        apiSecret,
      }),
    });
    if (res.ok) {
      const data = await res.json() as { token: string };
      sessionToken = data.token;
    }
  } catch (err) {
    logger.error('Failed to create session for collab list', { err });
  }

  if (!sessionToken) {
    await interaction.editReply({ content: 'Failed to authenticate. Please try again.' });
    return;
  }

  let connections: Array<{
    id: string;
    linkType: 'account' | 'api';
    status: string;
    webhookConfigured: boolean;
    collaboratorDiscordUserId: string;
    collaboratorDisplayName: string;
    createdAt: number;
  }> = [];

  try {
    const res = await fetch(`${apiBase}/api/collab/connections`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    if (res.ok) {
      const data = await res.json() as { connections: typeof connections };
      connections = data.connections ?? [];
    }
  } catch (err) {
    logger.error('Failed to fetch collab connections', { err });
  }

  if (connections.length === 0) {
    await interaction.editReply({
      content: `${E.Link} **Collaborator Connections**\n\nNo collaborator connections yet. Use \`/creator-admin collab invite\` to invite a creator.`,
    });
    return;
  }

  const activeConnections = connections.filter((c) => c.status === 'active');

  let content = `${E.Link} **Collaborator Connections** (${activeConnections.length} active)\n\n`;
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  for (const conn of activeConnections.slice(0, 5)) {
    const typeBadge = conn.linkType === 'account' ? '🔗 Account' : '🔑 API';
    const webhookStatus = conn.linkType === 'account'
      ? (conn.webhookConfigured ? ' • webhook ✓' : ' • webhook not configured')
      : '';
    content += `**<@${conn.collaboratorDiscordUserId}>** - ${typeBadge}${webhookStatus}\n`;

    const removeBtn = new ButtonBuilder()
      .setCustomId(`creator_collab:remove:${tenantId}:${conn.id}`)
      .setLabel(`Remove ${conn.collaboratorDisplayName || conn.collaboratorDiscordUserId}`)
      .setStyle(ButtonStyle.Danger);

    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(removeBtn));
  }

  if (connections.length > 5) {
    content += `\n_...and ${connections.length - 5} more_`;
  }

  await interaction.editReply({ content, components: rows });
}

/**
 * Handles the remove button click - removes a collaborator connection.
 */
export async function handleCollabRemove(
  interaction: ButtonInteraction,
  apiSecret: string,
  tenantId: Id<'tenants'>,
  connectionId: string,
): Promise<void> {
  await interaction.deferUpdate();

  const { apiInternal, apiPublic } = getApiUrls();
  const apiBase = apiInternal ?? apiPublic;

  if (!apiBase) {
    await interaction.editReply({ content: 'API base URL not configured.', components: [] });
    return;
  }

  // Get a session token
  let sessionToken: string | null = null;
  try {
    const res = await fetch(`${apiBase}/api/setup/create-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId,
        guildId: interaction.guildId ?? '',
        discordUserId: interaction.user.id,
        apiSecret,
      }),
    });
    if (res.ok) {
      const data = await res.json() as { token: string };
      sessionToken = data.token;
    }
  } catch (err) {
    logger.error('Failed to create session for collab remove', { err });
  }

  if (!sessionToken) {
    await interaction.editReply({ content: 'Failed to authenticate. Please try again.', components: [] });
    return;
  }

  try {
    const res = await fetch(`${apiBase}/api/collab/connections/${connectionId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    if (!res.ok) {
      await interaction.editReply({ content: `${E.X_} Failed to remove connection.`, components: [] });
      return;
    }
  } catch (err) {
    logger.error('Failed to remove collab connection', { err });
    await interaction.editReply({ content: `${E.X_} Network error. Please try again.`, components: [] });
    return;
  }

  await interaction.editReply({
    content: `${E.Checkmark} Collaborator connection removed.`,
    components: [],
  });
}

/**
 * Helper: generate an invite link and show it to the admin.
 */
async function generateAndShowInviteLink(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  apiBase: string,
  apiSecret: string,
  tenantId: Id<'tenants'>,
  guildId: string,
  guildName: string,
): Promise<void> {
  // Get a session token for the API call
  let sessionToken: string | null = null;
  try {
    const res = await fetch(`${apiBase}/api/setup/create-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId,
        guildId,
        discordUserId: interaction.user.id,
        apiSecret,
      }),
    });
    if (res.ok) {
      const data = await res.json() as { token: string };
      sessionToken = data.token;
    }
  } catch (err) {
    logger.error('Failed to create session for collab invite', { err });
  }

  if (!sessionToken) {
    await interaction.editReply({ content: 'Failed to authenticate. Please try again.', components: [] });
    return;
  }

  let inviteUrl: string | null = null;
  let expiresAt: number | null = null;

  try {
    const res = await fetch(`${apiBase}/api/collab/invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ guildName, guildId }),
    });
    if (res.ok) {
      const data = await res.json() as { inviteUrl: string; expiresAt: number };
      inviteUrl = data.inviteUrl;
      expiresAt = data.expiresAt;
    } else {
      const err = await res.json() as { error?: string };
      logger.error('Failed to create collab invite', { status: res.status, err });
    }
  } catch (err) {
    logger.error('Failed to call collab invite API', { err });
  }

  if (!inviteUrl) {
    await interaction.editReply({
      content: `${E.X_} Failed to generate invite link. Please try again.`,
      components: [],
    });
    return;
  }

  const expiryText = expiresAt
    ? `Expires <t:${Math.floor(expiresAt / 1000)}:R>`
    : 'Expires in 7 days';

  await interaction.editReply({
    content: [
      `${E.Link} **Collaborator invite link:**`,
      ``,
      `\`\`\`${inviteUrl}\`\`\``,
      `Share this link with the creator you'd like to invite. ${expiryText}.`,
    ].join('\n'),
    components: [],
  });
}
