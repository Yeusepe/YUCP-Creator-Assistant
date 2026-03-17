import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ChannelSelectMenuBuilder,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import {
  buildJinxxyModal,
  buildSetupStep2Components,
  handleSetupJinxxyModal,
  handleSetupSelect,
} from '../../commands/setup';
import type { InteractionHandlerContext } from './types';

export async function handleSetupButton(
  interaction: ButtonInteraction,
  _ctx: InteractionHandlerContext
): Promise<boolean> {
  const customId = interaction.customId;

  if (customId.startsWith('creator_setup:')) {
    const parts = customId.slice('creator_setup:'.length).split(':');
    const action = parts[0];
    const authUserId = parts[1];

    if (action === 'next' && authUserId) {
      const { logChannelSelect, jinxxyButton } = buildSetupStep2Components(authUserId as string);
      const embed = {
        title: 'Creator Setup - Step 2 of 3',
        description: 'Log channel and Jinxxy API key.',
        color: 0x5865f2,
      };
      const row1 = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
        logChannelSelect ?? new ChannelSelectMenuBuilder().setCustomId('dummy_select')
      );
      const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        jinxxyButton ?? new ButtonBuilder().setCustomId('dummy_btn').setLabel('Dummy').setStyle(1)
      );
      await interaction.update({ embeds: [embed], components: [row1, row2] });
      return true;
    }

    if (action === 'jinxxy_btn' && authUserId) {
      const modal = buildJinxxyModal(authUserId as string);
      if (modal) {
        // biome-ignore lint/suspicious/noExplicitAny: setup modal helper currently returns a looser builder shape.
        await interaction.showModal(modal as any);
      }
      return true;
    }

    // Unknown creator_setup:* action is still consumed by this domain
    return true;
  }

  return false;
}

export async function handleSetupModal(
  interaction: ModalSubmitInteraction,
  ctx: InteractionHandlerContext
): Promise<boolean> {
  const customId = interaction.customId;

  if (customId.startsWith('creator_setup:jinxxy:')) {
    await handleSetupJinxxyModal(interaction, ctx.convex, ctx.apiSecret);
    return true;
  }

  return false;
}

export async function handleSetupStringSelect(
  interaction: StringSelectMenuInteraction,
  ctx: InteractionHandlerContext
): Promise<boolean> {
  const customId = interaction.customId;

  if (customId.startsWith('creator_setup:')) {
    // biome-ignore lint/suspicious/noExplicitAny: setup select handler accepts the relevant select interactions at runtime.
    await handleSetupSelect(interaction as any, ctx.convex, ctx.apiSecret);
    return true;
  }

  return false;
}
