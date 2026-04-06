import { PROVIDER_REGISTRY } from '@yucp/providers/providerMetadata';
import type { ProviderDescriptor } from '@yucp/providers/types';
import type {
  ButtonInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import { MessageFlags } from 'discord.js';
import { api } from '../../../../../convex/_generated/api';
import { getNotConfiguredMessage } from './shared';
import type { InteractionHandlerContext } from './types';

export async function handleVerifyButton(
  interaction: ButtonInteraction,
  ctx: InteractionHandlerContext
): Promise<boolean> {
  const customId = interaction.customId;

  if (customId === 'verify_start') {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildLink = await ctx.convex.query(api.guildLinks.getByDiscordGuildForBot, {
      apiSecret: ctx.apiSecret,
      discordGuildId: guildId,
    });
    if (!guildLink) {
      await interaction.editReply({
        content: await getNotConfiguredMessage(guildId, interaction.user.id, ctx.apiSecret),
      });
      return true;
    }
    const { handleVerifyStartButton } = await import('../../commands/verify');
    await handleVerifyStartButton(
      interaction,
      ctx.convex,
      ctx.apiSecret,
      process.env.API_BASE_URL,
      {
        authUserId: guildLink.authUserId as string,
        guildId,
      }
    );
    return true;
  }

  if (customId.startsWith('creator_verify:disconnect:')) {
    const provider = customId.slice('creator_verify:disconnect:'.length);
    const VALID_PROVIDERS = new Set<string>(
      (PROVIDER_REGISTRY as readonly ProviderDescriptor[]).map((p) => p.providerKey)
    );
    if (!VALID_PROVIDERS.has(provider)) {
      await interaction.reply({ content: 'Invalid provider.', flags: MessageFlags.Ephemeral });
      return true;
    }
    const { handleVerifyDisconnectButton } = await import('../../commands/verify');
    await handleVerifyDisconnectButton(
      interaction,
      ctx.convex,
      ctx.apiSecret,
      process.env.API_BASE_URL,
      provider
    );
    return true;
  }

  if (customId.startsWith('creator_verify:license:')) {
    const authUserId = customId.slice('creator_verify:license:'.length) as string;
    const { showProductPicker } = await import('../../commands/licenseVerify');
    await showProductPicker(interaction, ctx.convex, ctx.apiSecret, authUserId);
    return true;
  }

  if (customId.startsWith('creator_verify:add_more:')) {
    const authUserId = customId.slice('creator_verify:add_more:'.length) as string;
    const guildId = interaction.guildId ?? '';
    const { handleVerifyAddMore } = await import('../../commands/verify');
    await handleVerifyAddMore(interaction, ctx.convex, ctx.apiSecret, process.env.API_BASE_URL, {
      authUserId,
      guildId,
    });
    return true;
  }

  if (
    customId.startsWith('creator_verify:lp_filter:') ||
    customId.startsWith('creator_verify:lp_page:')
  ) {
    const prefix = customId.startsWith('creator_verify:lp_filter:')
      ? 'creator_verify:lp_filter:'
      : 'creator_verify:lp_page:';
    const rest = customId.slice(prefix.length);
    const firstColon = rest.indexOf(':');
    const authUserId = firstColon >= 0 ? rest.slice(0, firstColon) : rest;
    const remainder = firstColon >= 0 ? rest.slice(firstColon + 1) : '';
    const secondColon = remainder.indexOf(':');
    const filter = (secondColon >= 0 ? remainder.slice(0, secondColon) : remainder) || 'all';
    const page = Number.parseInt(secondColon >= 0 ? remainder.slice(secondColon + 1) : '0', 10);
    const { handlePickerNavigation } = await import('../../commands/licenseVerify');
    await handlePickerNavigation(interaction, ctx.convex, ctx.apiSecret, authUserId, filter, page);
    return true;
  }

  return false;
}

export async function handleVerifyModal(
  interaction: ModalSubmitInteraction,
  ctx: InteractionHandlerContext
): Promise<boolean> {
  const customId = interaction.customId;

  if (customId.startsWith('creator_verify:lp_modal:')) {
    const { handleLicenseKeyModal } = await import('../../commands/licenseVerify');
    await handleLicenseKeyModal(interaction, ctx.convex, ctx.apiSecret, process.env.API_BASE_URL);
    return true;
  }

  return false;
}

export async function handleVerifyStringSelect(
  interaction: StringSelectMenuInteraction,
  _ctx: InteractionHandlerContext
): Promise<boolean> {
  const customId = interaction.customId;

  if (customId.startsWith('creator_verify:lp_select:')) {
    const rest = customId.slice('creator_verify:lp_select:'.length);
    const parts = rest.split(':');
    const authUserId = parts[0] as string;
    const { handleProductSelected } = await import('../../commands/licenseVerify');
    await handleProductSelected(interaction, authUserId);
    return true;
  }

  return false;
}
