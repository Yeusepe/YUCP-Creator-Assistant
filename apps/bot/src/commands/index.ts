/**
 * Discord slash command definitions and registration
 *
 * Uses discord.js REST API to register commands.
 * - /creator: user-facing (link, status, help) — visible to everyone
 * - /creator-admin: moderator-only — hidden from users without Administrator (see setDefaultMemberPermissions)
 *
 * @see https://discordjs.guide/slash-commands/permissions.html
 * @see https://discord.com/developers/docs/interactions/application-commands#application-command-object-application-command-structure
 */

import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

/** User-facing command: link, status, help. No defaultMemberPermissions so everyone can see and use it. */
const CREATOR_USER_COMMAND = new SlashCommandBuilder()
  .setName('creator')
  .setDescription('Creator Assistant - verification and management')
  .addSubcommand((s) =>
    s
      .setName('link')
      .setDescription('Link your account (Gumroad, Jinxxy, Discord)')
      .addStringOption((o) =>
        o
          .setName('provider')
          .setDescription('Provider to link')
          .setRequired(true)
          .addChoices(
            { name: 'Gumroad', value: 'gumroad' },
            { name: 'License key (Gumroad/Jinxxy)', value: 'license' },
            { name: 'Discord (other server)', value: 'discord' },
          ),
      ),
  )
  .addSubcommand((s) =>
    s.setName('status').setDescription('Show your verification status'),
  )
  .addSubcommand((s) => s.setName('help').setDescription('Help and usage'));

/** Admin-only command. setDefaultMemberPermissions hides it from users who don't have Administrator. */
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
        s
          .setName('add')
          .setDescription('Add product-role mapping')
          .addStringOption((o) =>
            o
              .setName('source')
              .setDescription('Verification source type')
              .setRequired(true)
              .addChoices(
                { name: 'Cross-server', value: 'cross_server' },
                { name: 'Discord role (other server)', value: 'discord_role' },
                { name: 'Gumroad', value: 'gumroad' },
                { name: 'Jinxxy', value: 'jinxxy' },
              ),
          )
          .addRoleOption((o) =>
            o.setName('role').setDescription('Role to assign when verified').setRequired(true),
          )
          .addStringOption((o) =>
            o
              .setName('url_or_id')
              .setDescription('Product URL or ID (for cross-server, Gumroad, Jinxxy)'),
          )
          .addStringOption((o) =>
            o
              .setName('source_guild_id')
              .setDescription('Source guild ID (for Discord role: guild where user must have role)'),
          )
          .addStringOption((o) =>
            o
              .setName('source_role_id')
              .setDescription('Source role ID (for Discord role: role user must have in source guild)'),
          ),
      )
      .addSubcommand((s) =>
        s.setName('list').setDescription('List product-role mappings'),
      )
      .addSubcommand((s) =>
        s
          .setName('remove')
          .setDescription('Remove product-role mapping')
          .addStringOption((o) =>
            o.setName('product_id').setDescription('Product ID to remove').setRequired(true),
          ),
      ),
  )
  .addSubcommandGroup((stats) =>
    stats
      .setName('stats')
      .setDescription('Verification statistics')
      .addSubcommand((s) => s.setName('overview').setDescription('Stats overview'))
      .addSubcommand((s) => s.setName('verified').setDescription('List verified users'))
      .addSubcommand((s) => s.setName('products').setDescription('Product verification counts'))
      .addSubcommand((s) =>
        s
          .setName('user')
          .setDescription('User verification status')
          .addUserOption((o) =>
            o.setName('user').setDescription('User to check').setRequired(true),
          ),
      ),
  )
  .addSubcommand((s) =>
    s.setName('verify-spawn').setDescription('Spawn verify button (admin only)'),
  )
  .addSubcommandGroup((drv) =>
    drv
      .setName('discord-role-verification')
      .setDescription('Enable/disable Discord role verification from other servers')
      .addSubcommand((s) => s.setName('disable').setDescription('Disable cross-server role verification'))
      .addSubcommand((s) => s.setName('enable').setDescription('Enable cross-server role verification'))
      .addSubcommand((s) => s.setName('status').setDescription('Show current status')),
  )
  .addSubcommandGroup((analytics) =>
    analytics
      .setName('analytics')
      .setDescription('Analytics')
      .addSubcommand((s) => s.setName('link').setDescription('View analytics dashboard link'))
      .addSubcommand((s) => s.setName('summary').setDescription('Key metrics summary')),
  )
  .addSubcommandGroup((suspicious) =>
    suspicious
      .setName('suspicious')
      .setDescription('Suspicious account management')
      .addSubcommand((s) =>
        s
          .setName('mark')
          .setDescription('Mark user as suspicious')
          .addUserOption((o) =>
            o.setName('user').setDescription('User to mark').setRequired(true),
          )
          .addStringOption((o) =>
            o.setName('reason').setDescription('Reason (piracy, double license, etc.)'),
          ),
      )
      .addSubcommand((s) => s.setName('list').setDescription('List suspicious accounts'))
      .addSubcommand((s) =>
        s
          .setName('clear')
          .setDescription('Clear suspicious flag')
          .addUserOption((o) =>
            o.setName('user').setDescription('User to clear').setRequired(true),
          ),
      ),
  );

/** User-facing subcommand names (under /creator) */
const USER_COMMANDS = ['link', 'status', 'help'];

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
