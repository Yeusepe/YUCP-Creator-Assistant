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

/** User-facing command: status panel + verify subcommand. Discord requires a subcommand when any exist. */
const CREATOR_USER_COMMAND = new SlashCommandBuilder()
  .setName('creator')
  .setDescription('Check your verification status and connect your accounts')
  .addSubcommand((s) =>
    s
      .setName('status')
      .setDescription('View your verification status and connect accounts (default)'),
  )
  .addSubcommand((s) =>
    s
      .setName('verify')
      .setDescription('Verify a purchase with a license key — pick a product and enter your key')
      .addStringOption((o) =>
        o
          .setName('product')
          .setDescription('Product to verify (start typing to search)')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('refresh')
      .setDescription('Refresh your Discord roles based on your connected accounts and purchases'),
  ) as SlashCommandBuilder;

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
      )
      .addSubcommand((s) =>
        s.setName('restart').setDescription('Restart onboarding wizard (generates a new secure link)'),
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
            o
              .setName('product_id')
              .setDescription('Product to remove (start typing to select)')
              .setRequired(true)
              .setAutocomplete(true),
          ),
      ),
  )
  .addSubcommandGroup((downloads) =>
    downloads
      .setName('downloads')
      .setDescription('Manage protected downloads')
      .addSubcommand((s) =>
        s
          .setName('setup')
          .setDescription('Set up protected downloads for a channel or forum'),
      )
      .addSubcommand((s) =>
        s.setName('manage').setDescription('View and manage protected download routes'),
      ),
  )
  .addSubcommand((s) =>
    s.setName('stats').setDescription('View verification statistics'),
  )
  .addSubcommand((s) =>
    s
      .setName('spawn-verify')
      .setDescription('Post a verify button in this channel (customize with options or use the beautiful default)')
      .addStringOption((o) =>
        o
          .setName('title')
          .setDescription('Embed title — leave empty for default: "Verify Your Purchase"'),
      )
      .addStringOption((o) =>
        o
          .setName('description')
          .setDescription('Embed body text — leave empty for default that explains how verification works'),
      )
      .addStringOption((o) =>
        o.setName('button_text').setDescription('Text on the verify button — default: "Verify"'),
      )
      .addStringOption((o) =>
        o
          .setName('color')
          .setDescription('Embed accent color as hex (e.g. #5865F2) — default: Discord blurple'),
      )
      .addStringOption((o) =>
        o.setName('image_url').setDescription('Optional banner image URL for the embed'),
      ),
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
      )
      .addSubcommand((s) =>
        s
          .setName('unverify')
          .setDescription('Remove a verified product from a user')
          .addUserOption((o) =>
            o.setName('user').setDescription('User to de-verify').setRequired(true),
          )
          .addStringOption((o) =>
            o
              .setName('product_id')
              .setDescription('Product to remove (start typing to select)')
              .setRequired(true)
              .setAutocomplete(true),
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
