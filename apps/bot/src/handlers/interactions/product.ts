import type {
  ButtonInteraction,
  ModalSubmitInteraction,
  RoleSelectMenuInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import type { InteractionHandlerContext } from './types';

export async function handleProductButton(
  interaction: ButtonInteraction,
  ctx: InteractionHandlerContext
): Promise<boolean> {
  const customId = interaction.customId;

  if (customId.startsWith('creator_product:confirm_add:')) {
    const rest = customId.slice('creator_product:confirm_add:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const authUserId = rest.slice(colonIdx + 1) as string;
    const { handleProductConfirmAdd } = await import('../../commands/product');
    await handleProductConfirmAdd(interaction, ctx.convex, ctx.apiSecret, userId, authUserId);
    return true;
  }

  if (customId.startsWith('creator_product:cancel_add:')) {
    const authUserId = customId.slice('creator_product:cancel_add:'.length) as string;
    const { handleProductCancelAdd } = await import('../../commands/product');
    await handleProductCancelAdd(interaction, interaction.user.id, authUserId);
    return true;
  }

  if (customId.startsWith('creator_product:discord_role_done:')) {
    const rest = customId.slice('creator_product:discord_role_done:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const authUserId = rest.slice(colonIdx + 1) as string;
    const { handleProductDiscordRoleDone } = await import('../../commands/product');
    await handleProductDiscordRoleDone(interaction, userId, authUserId);
    return true;
  }

  if (customId.startsWith('creator_product:confirm_remove:')) {
    const rest = customId.slice('creator_product:confirm_remove:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const authUserId = rest.slice(colonIdx + 1) as string;
    const { handleProductConfirmRemove } = await import('../../commands/product');
    await handleProductConfirmRemove(
      interaction as ButtonInteraction,
      ctx.convex,
      ctx.apiSecret,
      userId,
      authUserId
    );
    return true;
  }

  if (customId.startsWith('creator_product:cancel_remove:')) {
    const rest = customId.slice('creator_product:cancel_remove:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const authUserId = rest.slice(colonIdx + 1) as string;
    const { handleProductCancelRemove } = await import('../../commands/product');
    await handleProductCancelRemove(interaction as ButtonInteraction, userId, authUserId);
    return true;
  }

  return false;
}

export async function handleProductModal(
  interaction: ModalSubmitInteraction,
  _ctx: InteractionHandlerContext
): Promise<boolean> {
  const customId = interaction.customId;

  if (customId.startsWith('creator_product:url_modal:')) {
    const rest = customId.slice('creator_product:url_modal:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const authUserId = rest.slice(colonIdx + 1) as string;
    const { handleProductUrlModal } = await import('../../commands/product');
    await handleProductUrlModal(interaction, userId, authUserId);
    return true;
  }

  if (customId.startsWith('creator_product:discord_modal:')) {
    const rest = customId.slice('creator_product:discord_modal:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const authUserId = rest.slice(colonIdx + 1) as string;
    const { handleProductDiscordModal } = await import('../../commands/product');
    await handleProductDiscordModal(interaction, userId, authUserId);
    return true;
  }

  if (customId.startsWith('creator_product:payhip_modal:')) {
    const rest = customId.slice('creator_product:payhip_modal:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const authUserId = rest.slice(colonIdx + 1) as string;
    const { handleProductPayhipModal } = await import('../../commands/product');
    await handleProductPayhipModal(interaction, userId, authUserId);
    return true;
  }

  if (customId.startsWith('creator_product:per_product_cred_modal:')) {
    const rest = customId.slice('creator_product:per_product_cred_modal:'.length);
    const firstColon = rest.indexOf(':');
    const provider = rest.slice(0, firstColon);
    const rest2 = rest.slice(firstColon + 1);
    const colonIdx = rest2.indexOf(':');
    const userId = rest2.slice(0, colonIdx);
    const authUserId = rest2.slice(colonIdx + 1) as string;
    const { handleProductPerCredentialModal } = await import('../../commands/product');
    await handleProductPerCredentialModal(interaction, provider, userId, authUserId);
    return true;
  }

  return false;
}

export async function handleProductStringSelect(
  interaction: StringSelectMenuInteraction,
  ctx: InteractionHandlerContext
): Promise<boolean> {
  const customId = interaction.customId;

  if (customId.startsWith('creator_product:type_select:')) {
    const authUserId = customId.slice('creator_product:type_select:'.length) as string;
    const { handleProductTypeSelect } = await import('../../commands/product');
    await handleProductTypeSelect(interaction, authUserId, ctx.convex, ctx.apiSecret);
    return true;
  }

  if (customId.startsWith('creator_product:jinxxy_product_select:')) {
    const rest = customId.slice('creator_product:jinxxy_product_select:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const authUserId = rest.slice(colonIdx + 1) as string;
    const { handleProductJinxxySelect } = await import('../../commands/product');
    await handleProductJinxxySelect(interaction, userId, authUserId);
    return true;
  }

  if (customId.startsWith('creator_product:ls_product_select:')) {
    const rest = customId.slice('creator_product:ls_product_select:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const authUserId = rest.slice(colonIdx + 1) as string;
    const { handleProductLemonSqueezySelect } = await import('../../commands/product');
    await handleProductLemonSqueezySelect(interaction, userId, authUserId);
    return true;
  }

  if (customId.startsWith('creator_product:catalog_select:')) {
    const rest = customId.slice('creator_product:catalog_select:'.length);
    const firstColon = rest.indexOf(':');
    const provider = rest.slice(0, firstColon);
    const rest2 = rest.slice(firstColon + 1);
    const colonIdx = rest2.indexOf(':');
    const userId = rest2.slice(0, colonIdx);
    const authUserId = rest2.slice(colonIdx + 1) as string;
    const { handleProductCatalogSelect } = await import('../../commands/product');
    await handleProductCatalogSelect(interaction, provider, userId, authUserId);
    return true;
  }

  if (customId.startsWith('creator_product:remove_select:')) {
    const authUserId = customId.slice('creator_product:remove_select:'.length) as string;
    const { handleProductRemoveSelect } = await import('../../commands/product');
    await handleProductRemoveSelect(
      interaction as StringSelectMenuInteraction,
      ctx.convex,
      ctx.apiSecret,
      authUserId
    );
    return true;
  }

  return false;
}

export async function handleProductRoleSelect(
  interaction: RoleSelectMenuInteraction,
  _ctx: InteractionHandlerContext
): Promise<boolean> {
  const customId = interaction.customId;

  if (customId.startsWith('creator_product:role_select:')) {
    const rest = customId.slice('creator_product:role_select:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const authUserId = rest.slice(colonIdx + 1) as string;
    const { handleProductRoleSelect: handleRoleSelect } = await import('../../commands/product');
    await handleRoleSelect(interaction, userId, authUserId);
    return true;
  }

  return false;
}
