import type {
  ButtonInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import type { InteractionHandlerContext } from './types';

export async function handleCollabButton(
  interaction: ButtonInteraction,
  ctx: InteractionHandlerContext
): Promise<boolean> {
  const customId = interaction.customId;

  if (customId.startsWith('creator_collab:remove:')) {
    const rest = customId.slice('creator_collab:remove:'.length);
    const colonIdx = rest.indexOf(':');
    const authUserId = rest.slice(0, colonIdx) as string;
    const connectionId = rest.slice(colonIdx + 1);
    const { handleCollabRemove } = await import('../../commands/collab');
    await handleCollabRemove(interaction, ctx.apiSecret, authUserId, connectionId);
    return true;
  }

  return false;
}

export async function handleCollabModal(
  interaction: ModalSubmitInteraction,
  ctx: InteractionHandlerContext
): Promise<boolean> {
  const customId = interaction.customId;

  if (customId.startsWith('creator_collab:add_modal:')) {
    const rest = customId.slice('creator_collab:add_modal:'.length);
    const colonIdx = rest.indexOf(':');
    // New format: providerKey:authUserId. Old format (backward compat): authUserId only.
    let providerKey: string;
    let authUserId: string;
    if (colonIdx !== -1) {
      providerKey = rest.slice(0, colonIdx);
      authUserId = rest.slice(colonIdx + 1) as string;
    } else {
      providerKey = 'jinxxy';
      authUserId = rest as string;
    }
    const { handleCollabAddModalSubmit } = await import('../../commands/collab');
    await handleCollabAddModalSubmit(interaction, ctx.apiSecret, authUserId, providerKey);
    return true;
  }

  return false;
}

export async function handleCollabStringSelect(
  interaction: StringSelectMenuInteraction,
  _ctx: InteractionHandlerContext
): Promise<boolean> {
  const customId = interaction.customId;

  if (customId.startsWith('creator_collab:invite_select:')) {
    const authUserId = customId.slice('creator_collab:invite_select:'.length) as string;
    const { handleCollabInviteProviderSelect } = await import('../../commands/collab');
    await handleCollabInviteProviderSelect(interaction, authUserId);
    return true;
  }

  if (customId.startsWith('creator_collab:add_select:')) {
    const authUserId = customId.slice('creator_collab:add_select:'.length) as string;
    const { handleCollabAddProviderSelect } = await import('../../commands/collab');
    await handleCollabAddProviderSelect(interaction, authUserId);
    return true;
  }

  return false;
}
