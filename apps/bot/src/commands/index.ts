/**
 * Discord slash command definitions and registration
 *
 * Uses discord.js REST API to register commands.
 * - /creator: user-facing — visible to everyone, no subcommands (state-aware status panel)
 * - /creator-admin: moderator-only — hidden from users without Administrator
 *
 * @see https://discordjs.guide/slash-commands/permissions.html
 */

import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

/** User-facing command: single entry point, state-aware status + verify panel. */
const CREATOR_USER_COMMAND = new SlashCommandBuilder()
  .setName('creator')
  .setDescription('Check your verification status and connect your accounts');

/** Admin-only command. setDefaultMemberPermissions hides it from non-admins. */
const CREATOR_ADMIN_COMMAND = new SlashCommandBuilder()
  .setName('creator-admin')
  .setDescription('Creator Assistant — configuration and moderation (admin only)')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommandGroup((setup) =>
    setup
      .setName('setup')
      .setDescription('Onboarding and configuration')
      .addSubcommand((s) =>
        s.setName('start').setDescription('Start onboarding wizard'),
      ),
  )
  .addSubcommandGroup((product) =>
    product
      .setName('product')
      .setDescription('Product-role mapping')
      .addSubcommand((s) =>
        s.setName('add').setDescription('Add a product-role mapping (guided setup)'),
      )
      .addSubcommand((s) =>
        s.setName('list').setDescription('List product-role mappings'),
      )
      .addSubcommand((s) =>
        s
          .setName('remove')
          .setDescription('Remove a product-role mapping')
          .addStringOption((o) =>
            o.setName('product_id').setDescription('Product ID to remove').setRequired(true),
          ),
      ),
  )
  .addSubcommand((s) =>
    s.setName('stats').setDescription('View verification statistics'),
  )
  .addSubcommand((s) =>
    s.setName('spawn-verify').setDescription('Spawn verify button in channel'),
  )
  .addSubcommandGroup((settings) =>
    settings
      .setName('settings')
      .setDescription('Server settings')
      .addSubcommand((s) =>
        s.setName('cross-server').setDescription('Manage cross-server role verification'),
      ),
  )
  .addSubcommand((s) =>
    s.setName('analytics').setDescription('View analytics and key metrics'),
  )
  .addSubcommandGroup((mod) =>
    mod
      .setName('moderation')
      .setDescription('Suspicious account management')
      .addSubcommand((s) =>
        s
          .setName('mark')
          .setDescription('Flag a user as suspicious')
          .addUserOption((o) =>
            o.setName('user').setDescription('User to flag').setRequired(true),
          ),
      )
      .addSubcommand((s) =>
        s.setName('list').setDescription('List flagged accounts'),
      )
      .addSubcommand((s) =>
        s
          .setName('clear')
          .setDescription('Clear suspicious flag')
          .addUserOption((o) =>
            o.setName('user').setDescription('User to clear').setRequired(true),
          ),
      ),
  );

/** No user-facing subcommands — /creator has no subcommands */
const USER_COMMANDS: string[] = [];

export async function registerCommands(
  token: string,
  clientId: string,
  guildId?: string,
): Promise<void> {
  const rest = new REST().setToken(token);
  const body = [
    CREATOR_USER_COMMAND.toJSON(),
    CREATOR_ADMIN_COMMAND.toJSON(),
  ];

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body });
  }
}

export { CREATOR_USER_COMMAND, CREATOR_ADMIN_COMMAND, USER_COMMANDS };
