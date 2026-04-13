/**
 * Collaborating Creators - /creator-admin collab invite/list
 *
 * Allows a server owner to generate an invite link for a collaborator to share
 * their credentials for cross-store license verification.
 * The collaborator's identity is verified via Discord OAuth on the consent page.
 */

import { PROVIDER_REGISTRY } from '@yucp/providers/providerMetadata';
import type { ProviderDescriptor } from '@yucp/providers/types';
import { createLogger } from '@yucp/shared';
import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { getApiUrls } from '../lib/apiUrls';
import { E } from '../lib/emojis';
import {
  addCollaboratorConnectionManual,
  createCollaboratorInvite,
  listCollaboratorConnections,
  removeCollaboratorConnection,
} from '../lib/internalRpc';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

/**
 * /creator-admin collab invite
 * Shows a provider selector so the admin can specify what kind of credential the collaborator
 * will submit. Generates and shows the invite link after the provider is chosen.
 */
export async function handleCollabInvite(
  interaction: ChatInputCommandInteraction,
  _apiSecret: string,
  authUserId: string
): Promise<void> {
  const collabProviders = (PROVIDER_REGISTRY as readonly ProviderDescriptor[]).filter(
    (provider) => provider.collabCredential != null
  );

  if (collabProviders.length === 0) {
    await interaction.reply({
      content: `${E.X_} No providers support collaborator invites at this time.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`creator_collab:invite_select:${authUserId}`)
    .setPlaceholder('Select a provider')
    .addOptions(
      collabProviders.map((p) =>
        new StringSelectMenuOptionBuilder().setLabel(p.label).setValue(p.providerKey)
      )
    );

  await interaction.reply({
    content: `${E.Link} **Create Collaborator Invite**, Select the provider for the collaborator's credential:`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Handle provider selection for collab invite, generates and shows the invite link.
 */
export async function handleCollabInviteProviderSelect(
  interaction: StringSelectMenuInteraction,
  authUserId: string
): Promise<void> {
  const providerKey = interaction.values[0];
  if (!providerKey) {
    await interaction.reply({
      content: `${E.X_} No provider selected.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();

  const { apiInternal, apiPublic } = getApiUrls();
  const apiBase = apiInternal ?? apiPublic;

  if (!apiBase) {
    await interaction.editReply({ content: 'API base URL not configured.', components: [] });
    return;
  }

  await generateAndShowInviteLink(
    interaction,
    apiBase,
    authUserId,
    interaction.guildId ?? '',
    interaction.guild?.name ?? 'this server',
    providerKey
  );
}

/**
 * /creator-admin collab add
 * Shows a provider selector for providers that support manual collaborator connections.
 */
export async function handleCollabAdd(
  interaction: ChatInputCommandInteraction,
  _apiSecret: string,
  authUserId: string
): Promise<void> {
  const collabProviders = (PROVIDER_REGISTRY as readonly ProviderDescriptor[]).filter(
    (provider) => provider.collabCredential != null
  );

  if (collabProviders.length === 0) {
    await interaction.reply({
      content: `${E.X_} No providers support manual collaborator connections at this time.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`creator_collab:add_select:${authUserId}`)
    .setPlaceholder('Select a provider')
    .addOptions(
      collabProviders.map((p) =>
        new StringSelectMenuOptionBuilder().setLabel(p.label).setValue(p.providerKey)
      )
    );

  await interaction.reply({
    content: `${E.Key} **Add Collaborator**, Select the provider for the credential:`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Handle provider selection for collab add, shows the credential modal.
 */
export async function handleCollabAddProviderSelect(
  interaction: StringSelectMenuInteraction,
  authUserId: string
): Promise<void> {
  const providerKey = interaction.values[0];
  if (!providerKey) {
    await interaction.reply({
      content: `${E.X_} No provider selected.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const descriptor = (PROVIDER_REGISTRY as readonly ProviderDescriptor[]).find(
    (p) => p.providerKey === providerKey
  );
  if (!descriptor?.collabCredential) {
    await interaction.reply({
      content: `${E.X_} Provider not configured for manual collaboration.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`creator_collab:add_modal:${providerKey}:${authUserId}`)
    .setTitle(`Add Collaborator – ${descriptor.label}`);

  const keyInput = new TextInputBuilder()
    .setCustomId('collab_credential')
    .setLabel(descriptor.collabCredential.label)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(10);

  if (descriptor.collabCredential.placeholder) {
    keyInput.setPlaceholder(descriptor.collabCredential.placeholder);
  }

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(keyInput));
  await interaction.showModal(modal);
}

/**
 * Handle modal submit for collab add.
 * providerKey is extracted from the customId by the interactions handler.
 */
export async function handleCollabAddModalSubmit(
  interaction: ModalSubmitInteraction,
  _apiSecret: string,
  authUserId: string,
  providerKey: string
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Support both 'collab_credential' (new) and 'jinxxy_api_key' (old, backward compat)
  let credential: string | undefined;
  try {
    credential = interaction.fields.getTextInputValue('collab_credential')?.trim();
  } catch (_) {}
  if (!credential) {
    try {
      credential = interaction.fields.getTextInputValue('jinxxy_api_key')?.trim();
    } catch (_) {}
  }

  if (!credential) {
    await interaction.editReply({ content: `${E.X_} Credential is required.` });
    return;
  }

  const { apiInternal, apiPublic } = getApiUrls();
  const apiBase = apiInternal ?? apiPublic;

  if (!apiBase) {
    await interaction.editReply({ content: 'API base URL not configured.' });
    return;
  }

  try {
    const data = await addCollaboratorConnectionManual({
      authUserId,
      guildId: interaction.guildId ?? '',
      actorDiscordUserId: interaction.user.id,
      providerKey,
      credential,
      serverName: interaction.guild?.name ?? 'this server',
    });

    if (!data.success) {
      await interaction.editReply({
        content: `${E.X_} ${data.error ?? 'Failed to add connection.'}`,
      });
      return;
    }

    await interaction.editReply({
      content: `${E.Checkmark} **${data.displayName ?? 'Collaborator'}** has been added. A verification email was sent if they have an email on file.`,
    });
  } catch (err) {
    logger.error('Failed to add collab connection', { err });
    await interaction.editReply({ content: `${E.X_} Network error. Please try again.` });
  }
}

/**
 * /creator-admin collab list
 * Shows the list of active collaborator connections.
 */
export async function handleCollabList(
  interaction: ChatInputCommandInteraction,
  _apiSecret: string,
  authUserId: string
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { apiInternal, apiPublic } = getApiUrls();
  const apiBase = apiInternal ?? apiPublic;

  if (!apiBase) {
    await interaction.editReply({ content: 'API base URL not configured.' });
    return;
  }

  let connections: Array<{
    id: string;
    linkType: 'account' | 'api';
    status: string;
    source?: 'invite' | 'manual';
    webhookConfigured: boolean;
    collaboratorDiscordUserId: string;
    collaboratorDisplayName: string;
    createdAt: number;
  }> = [];

  try {
    connections = await listCollaboratorConnections({
      authUserId,
      guildId: interaction.guildId ?? '',
      actorDiscordUserId: interaction.user.id,
    });
  } catch (err) {
    logger.error('Failed to fetch collab connections', { err });
    await interaction.editReply({
      content: `${E.X_} Failed to load collaborator connections. Please try again.`,
    });
    return;
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
    const manualBadge = conn.source === 'manual' ? ' [Manual]' : '';
    const webhookStatus =
      conn.linkType === 'account'
        ? conn.webhookConfigured
          ? ' • webhook ✓'
          : ' • webhook not configured'
        : '';
    const collaboratorLabel = /^\d+$/.test(conn.collaboratorDiscordUserId)
      ? `**<@${conn.collaboratorDiscordUserId}>**`
      : `**${conn.collaboratorDisplayName}**`;
    content += `${collaboratorLabel} - ${typeBadge}${manualBadge}${webhookStatus}\n`;

    const removeBtn = new ButtonBuilder()
      .setCustomId(`creator_collab:remove:${authUserId}:${conn.id}`)
      .setLabel(`Remove ${conn.collaboratorDisplayName || conn.collaboratorDiscordUserId}`)
      .setStyle(ButtonStyle.Danger);

    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(removeBtn));
  }

  if (activeConnections.length > 5) {
    content += `\n_...and ${activeConnections.length - 5} more_`;
  }

  await interaction.editReply({ content, components: rows });
}

/**
 * Handles the remove button click - removes a collaborator connection.
 */
export async function handleCollabRemove(
  interaction: ButtonInteraction,
  _apiSecret: string,
  authUserId: string,
  connectionId: string
): Promise<void> {
  await interaction.deferUpdate();

  const { apiInternal, apiPublic } = getApiUrls();
  const apiBase = apiInternal ?? apiPublic;

  if (!apiBase) {
    await interaction.editReply({ content: 'API base URL not configured.', components: [] });
    return;
  }

  try {
    const response = await removeCollaboratorConnection({
      authUserId,
      guildId: interaction.guildId ?? '',
      actorDiscordUserId: interaction.user.id,
      connectionId,
    });
    if (!response.success) {
      await interaction.editReply({
        content: `${E.X_} Failed to remove connection.`,
        components: [],
      });
      return;
    }
  } catch (err) {
    logger.error('Failed to remove collab connection', { err });
    await interaction.editReply({
      content: `${E.X_} Network error. Please try again.`,
      components: [],
    });
    return;
  }

  await interaction.editReply({
    content: `${E.Checkmark} Collaborator connection removed.`,
    components: [],
  });
}

/**
 * Helper: generate an invite link for the given provider and show it to the admin.
 */
async function generateAndShowInviteLink(
  interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction,
  _apiBase: string,
  authUserId: string,
  guildId: string,
  guildName: string,
  providerKey: string
): Promise<void> {
  let inviteUrl: string | null = null;
  let expiresAt: number | null = null;

  try {
    const data = await createCollaboratorInvite({
      authUserId,
      guildId,
      guildName,
      actorDiscordUserId: interaction.user.id,
      providerKey,
    });
    inviteUrl = data.inviteUrl ?? null;
    expiresAt = data.expiresAt ? Number(data.expiresAt) : null;
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
      '',
      `\`\`\`${inviteUrl}\`\`\``,
      `Share this link with the creator you'd like to invite. ${expiryText}.`,
    ].join('\n'),
    components: [],
  });
}
