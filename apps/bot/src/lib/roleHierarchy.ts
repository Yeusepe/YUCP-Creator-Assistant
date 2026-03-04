/**
 * Discord role hierarchy utilities
 *
 * Per Discord API: a bot can only assign/remove roles that are BELOW its highest
 * role in the server's role list. Higher position = more power.
 *
 * @see https://discord.com/developers/docs/topics/permissions#role-object
 * @see https://discordjs.guide/popular-topics/permissions.html#the-permission-hierarchy
 */

import type { Guild } from 'discord.js';

/**
 * Check if the bot can manage (add/remove) a given role in a guild.
 * Returns canManage: false when the role is at or above the bot's highest role.
 */
export function canBotManageRole(
  guild: Guild,
  roleId: string
): { canManage: boolean; reason?: string } {
  const role = guild.roles.cache.get(roleId);
  const botMember = guild.members.me;

  if (!role) {
    return { canManage: false, reason: 'Role not found in this server.' };
  }
  if (!botMember) {
    return { canManage: false, reason: 'Bot is not in this server.' };
  }

  // Discord: bot can only manage roles BELOW its highest role (lower position)
  if (role.position >= botMember.roles.highest.position) {
    return {
      canManage: false,
      reason:
        "The verified role is at or above the bot's role in Server Settings → Roles. " +
        "Move the bot's role higher than the verified role so it can assign it.",
    };
  }

  return { canManage: true };
}
