/**
 * Role Sync Actions
 *
 * Workpool-executed actions that grant/remove Discord roles via the Discord
 * REST API (no gateway/discord.js needed). Ported from the bot's
 * RoleSyncService.processRoleSyncJob / processRoleRemovalJob.
 *
 * Result contract (consumed by convex/roleSyncOnComplete.ts):
 *  - throw  -> transient failure; Workpool retries with backoff (e.g. 429, 5xx,
 *              network, member-not-yet-in-guild).
 *  - return { success: true,  ... } -> all required roles applied (or no-op).
 *  - return { success: false, ... } -> permanent failure; onComplete dead-letters.
 *
 * The action reads entitlement/tier/rule data through ungated internalQuery
 * variants because it runs inside Convex and has no API secret / service actor.
 */

import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalAction } from './_generated/server';

// Discord guild member role endpoints:
// https://docs.discord.com/developers/resources/guild#add-guild-member-role
// https://docs.discord.com/developers/resources/guild#remove-guild-member-role
// Discord JSON error shape:
// https://docs.discord.com/developers/topics/opcodes-and-status-codes#json
const DISCORD_API_BASE = 'https://discord.com/api/v10';

interface RoleRule {
  guildId: string;
  verifiedRoleId?: string;
  verifiedRoleIds?: string[];
  catalogTierId?: Id<'catalog_tiers'>;
  enabled: boolean;
}

export interface RoleSyncActionResult {
  success: boolean;
  guildId: string;
  targetGuildIds: string[];
  discordUserId: string;
  rolesAdded: string[];
  rolesRemoved: string[];
  error?: string;
  skipped?: boolean;
}

class RetriableRoleSyncError extends Error {}

function botAuthHeaders(): Record<string, string> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    // Misconfiguration, not a per-user problem: retry so it self-heals once the
    // env var is synced, rather than dead-lettering every job.
    throw new RetriableRoleSyncError('DISCORD_BOT_TOKEN not configured');
  }
  return {
    Authorization: `Bot ${token}`,
    'Content-Type': 'application/json',
  };
}

/** Discord error body: { message, code }. */
async function parseDiscordError(res: Response): Promise<{ code?: number; message: string }> {
  try {
    const body = (await res.json()) as { code?: number; message?: string };
    return { code: body.code, message: body.message ?? `HTTP ${res.status}` };
  } catch {
    return { message: `HTTP ${res.status}` };
  }
}

/**
 * Idempotent role add. PUT returns 204 whether or not the member already had the
 * role. Returns { added } on success, { error, retriable } on failure.
 */
async function addRoleToMember(
  guildId: string,
  discordUserId: string,
  roleId: string
): Promise<{ added: boolean; error?: string; retriable?: boolean }> {
  const res = await fetch(
    `${DISCORD_API_BASE}/guilds/${guildId}/members/${discordUserId}/roles/${roleId}`,
    {
      method: 'PUT',
      headers: { ...botAuthHeaders(), 'X-Audit-Log-Reason': 'Entitlement sync - role granted' },
    }
  );

  if (res.ok) {
    return { added: true };
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    return {
      added: false,
      retriable: true,
      error: `Rate limited${retryAfter ? ` (retry after ${retryAfter}s)` : ''}`,
    };
  }

  const { code, message } = await parseDiscordError(res);

  // 10007 Unknown Member: not in the guild yet (propagation race) or never
  // joined. Retry; guildMemberAdd re-enqueues a fresh job on real join.
  if (code === 10007) {
    return { added: false, retriable: true, error: 'Member not found in guild' };
  }
  if (code === 10011) {
    return { added: false, error: 'Role not found' };
  }
  if (code === 50013) {
    return {
      added: false,
      error:
        'Bot lacks permission: Grant "Manage Roles" to the bot and ensure the bot\'s role is above the verified role in Server Settings > Roles.',
    };
  }
  if (code === 50001) {
    return {
      added: false,
      error:
        'Missing Access (50001): Enable Server Members Intent in Developer Portal, ensure the role is not managed by an integration, and that the bot is in the guild.',
    };
  }
  // 5xx is transient; unknown 4xx will not fix itself by retrying.
  if (res.status >= 500) {
    return { added: false, retriable: true, error: `Discord error: ${message}` };
  }
  return { added: false, error: `Discord error: ${message}` };
}

/** Idempotent role remove. DELETE returns 204 whether or not present. */
async function removeRoleFromMember(
  guildId: string,
  discordUserId: string,
  roleId: string
): Promise<{ removed: boolean; error?: string; retriable?: boolean }> {
  const res = await fetch(
    `${DISCORD_API_BASE}/guilds/${guildId}/members/${discordUserId}/roles/${roleId}`,
    {
      method: 'DELETE',
      headers: { ...botAuthHeaders(), 'X-Audit-Log-Reason': 'Entitlement revoked - role removed' },
    }
  );

  if (res.ok) {
    return { removed: true };
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    return {
      removed: false,
      retriable: true,
      error: `Rate limited${retryAfter ? ` (retry after ${retryAfter}s)` : ''}`,
    };
  }

  const { code, message } = await parseDiscordError(res);
  // Member gone or role gone => already in the desired state.
  if (code === 10007 || code === 10011) {
    return { removed: true };
  }
  if (code === 50013) {
    return {
      removed: false,
      error:
        'Bot lacks permission: Grant "Manage Roles" to the bot and ensure the bot\'s role is above the verified role in Server Settings > Roles.',
    };
  }
  if (code === 50001) {
    return { removed: false, error: 'Missing Access (50001)' };
  }
  if (res.status >= 500) {
    return { removed: false, retriable: true, error: `Discord error: ${message}` };
  }
  return { removed: false, error: `Discord error: ${message}` };
}

export const runRoleSync = internalAction({
  args: {
    outboxJobId: v.id('outbox_jobs'),
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    entitlementId: v.id('entitlements'),
    discordUserId: v.optional(v.string()),
    targetGuildId: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args): Promise<RoleSyncActionResult> => {
    const discordUserId = args.discordUserId;
    if (!discordUserId) {
      // Permanent: nothing to act on.
      return {
        success: false,
        guildId: '',
        targetGuildIds: [],
        discordUserId: '',
        rolesAdded: [],
        rolesRemoved: [],
        error: 'No Discord user ID in payload',
      };
    }

    const entitlement = await ctx.runQuery(internal.entitlements.getEntitlementInternal, {
      entitlementId: args.entitlementId,
    });
    if (!entitlement) {
      return {
        success: false,
        guildId: '',
        targetGuildIds: [],
        discordUserId,
        rolesAdded: [],
        rolesRemoved: [],
        error: `Entitlement not found: ${args.entitlementId}`,
      };
    }
    if (entitlement.status !== 'active') {
      // Not an error: nothing to grant for an inactive entitlement.
      return {
        success: true,
        skipped: true,
        guildId: '',
        targetGuildIds: [],
        discordUserId,
        rolesAdded: [],
        rolesRemoved: [],
        error: 'Entitlement not active, skipping sync',
      };
    }

    const activeCatalogTierIds = await ctx.runQuery(
      internal.catalogTiers.getActiveCatalogTierIdsForEntitlementInternal,
      { entitlementId: args.entitlementId }
    );

    let roleRules = (await ctx.runQuery(internal.role_rules.getByProductInternal, {
      authUserId: args.authUserId,
      productId: entitlement.productId,
    })) as RoleRule[];

    if (activeCatalogTierIds.length > 0) {
      const activeTierIdSet = new Set<string>(activeCatalogTierIds);
      roleRules = roleRules.filter(
        (rule) => !rule.catalogTierId || activeTierIdSet.has(rule.catalogTierId)
      );
    } else {
      roleRules = roleRules.filter((rule) => !rule.catalogTierId);
    }

    if (args.targetGuildId) {
      roleRules = roleRules.filter((rule) => rule.guildId === args.targetGuildId);
    }

    if (roleRules.length === 0) {
      return {
        success: true,
        skipped: true,
        guildId: '',
        targetGuildIds: [],
        discordUserId,
        rolesAdded: [],
        rolesRemoved: [],
        error: 'No role rules configured for product',
      };
    }

    const rolesAdded: string[] = [];
    const errors: string[] = [];
    const enabledGuildIds = new Set<string>();
    const failedGuildIds = new Set<string>();
    let expectedRoleGrantCount = 0;
    let hasRetriable = false;

    for (const rule of roleRules) {
      if (!rule.enabled) {
        continue;
      }
      enabledGuildIds.add(rule.guildId);
      const roleIds = rule.verifiedRoleIds ?? (rule.verifiedRoleId ? [rule.verifiedRoleId] : []);

      for (const roleId of roleIds) {
        expectedRoleGrantCount++;
        const result = await addRoleToMember(rule.guildId, discordUserId, roleId);
        if (result.added) {
          rolesAdded.push(roleId);
        }
        if (result.error) {
          errors.push(`${rule.guildId}: ${result.error}`);
          failedGuildIds.add(rule.guildId);
          if (result.retriable) {
            hasRetriable = true;
          }
        }
      }
    }

    const enabledRoleRuleCount = roleRules.filter((r) => r.enabled).length;
    const missingRoleConfiguration =
      enabledRoleRuleCount > 0 && expectedRoleGrantCount === 0
        ? 'No verified role ids configured for enabled role rules'
        : undefined;
    if (missingRoleConfiguration) {
      for (const guildId of enabledGuildIds) {
        failedGuildIds.add(guildId);
      }
    }

    const success =
      enabledRoleRuleCount === 0 ||
      (expectedRoleGrantCount > 0 &&
        errors.length === 0 &&
        rolesAdded.length === expectedRoleGrantCount);
    const error = errors.length > 0 ? errors.join('; ') : missingRoleConfiguration;

    // Any transient failure => retry the whole job (idempotent PUTs make this safe).
    if (!success && hasRetriable) {
      throw new RetriableRoleSyncError(error ?? 'Role sync transient failure');
    }

    return {
      success,
      guildId: roleRules[0]?.guildId ?? '',
      targetGuildIds: Array.from(success ? enabledGuildIds : failedGuildIds),
      discordUserId,
      rolesAdded,
      rolesRemoved: [],
      error,
    };
  },
});

export const runRoleRemoval = internalAction({
  args: {
    outboxJobId: v.id('outbox_jobs'),
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    entitlementId: v.optional(v.id('entitlements')),
    guildId: v.string(),
    roleId: v.string(),
    discordUserId: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args): Promise<RoleSyncActionResult> => {
    const discordUserId = args.discordUserId;
    if (!discordUserId) {
      return {
        success: false,
        guildId: args.guildId,
        targetGuildIds: [args.guildId],
        discordUserId: '',
        rolesAdded: [],
        rolesRemoved: [],
        error: 'No Discord user ID in payload',
      };
    }

    // Grant-then-revoke ordering guard: if the entitlement is active again, the
    // role should stay. Skip the removal.
    if (args.entitlementId) {
      const entitlement = await ctx.runQuery(internal.entitlements.getEntitlementInternal, {
        entitlementId: args.entitlementId,
      });
      if (entitlement && entitlement.status === 'active') {
        return {
          success: true,
          skipped: true,
          guildId: args.guildId,
          targetGuildIds: [args.guildId],
          discordUserId,
          rolesAdded: [],
          rolesRemoved: [],
          error: 'Entitlement active again, skipping removal',
        };
      }
    }

    const result = await removeRoleFromMember(args.guildId, discordUserId, args.roleId);
    if (!result.removed && result.retriable) {
      throw new RetriableRoleSyncError(result.error ?? 'Role removal transient failure');
    }

    return {
      success: result.removed,
      guildId: args.guildId,
      targetGuildIds: [args.guildId],
      discordUserId,
      rolesAdded: [],
      rolesRemoved: result.removed ? [args.roleId] : [],
      error: result.error,
    };
  },
});
