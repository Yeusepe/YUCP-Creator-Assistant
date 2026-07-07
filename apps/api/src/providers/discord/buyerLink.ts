import { api } from '../../../../../convex/_generated/api';
import { encrypt } from '../../lib/encrypt';
import type { BuyerLinkPlugin } from '../types';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const DISCORD_TOKEN_PURPOSE = 'discord-oauth-access-token';
const DISCORD_API_TIMEOUT_MS = 10_000;
const DISCORD_RETRY_AFTER_MAX_MS = 5_000;

interface DiscordUserResponse {
  id?: string;
  username?: string;
  avatar?: string;
  email?: string;
}

interface DiscordGuildMemberResponse {
  roles?: string[];
}

async function fetchDiscordIdentity(accessToken: string) {
  // Discord Get Current User docs:
  // https://discord.com/developers/docs/resources/user#get-current-user
  const response = await fetch(`${DISCORD_API_BASE}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(DISCORD_API_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error('Failed to fetch Discord user');
  }

  const data = (await response.json()) as DiscordUserResponse;
  if (!data.id) {
    throw new Error('Could not determine Discord user ID');
  }

  return {
    providerUserId: data.id,
    username: data.username,
    email: data.email,
    avatarUrl: data.avatar
      ? `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.png`
      : undefined,
    profileUrl: `https://discord.com/users/${data.id}`,
  };
}

async function fetchGuildMember(
  accessToken: string,
  guildId: string
): Promise<DiscordGuildMemberResponse> {
  // Discord Get Current User Guild Member docs:
  // https://discord.com/developers/docs/resources/user#get-current-user-guild-member
  let response = await fetch(`${DISCORD_API_BASE}/users/@me/guilds/${guildId}/member`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(DISCORD_API_TIMEOUT_MS),
  });

  if (response.status === 429) {
    const retryAfter = Number.parseFloat(response.headers.get('Retry-After') ?? '5');
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(Number.isFinite(retryAfter) ? retryAfter * 1000 : 5000, DISCORD_RETRY_AFTER_MAX_MS)
      )
    );
    response = await fetch(`${DISCORD_API_BASE}/users/@me/guilds/${guildId}/member`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(DISCORD_API_TIMEOUT_MS),
    });
  }

  if (response.status === 403 || response.status === 404) {
    return { roles: [] };
  }
  if (!response.ok) {
    throw new Error('Failed to fetch Discord guild member');
  }

  return (await response.json()) as DiscordGuildMemberResponse;
}

export function createDiscordBuyerLinkPlugin(): BuyerLinkPlugin {
  return {
    oauth: {
      providerId: 'discord',
      mode: 'discord',
      aliases: ['discord_role'],
      authUrl: 'https://discord.com/api/oauth2/authorize',
      tokenUrl: 'https://discord.com/api/oauth2/token',
      scopes: ['identify', 'guilds', 'guilds.members.read'],
      callbackPath: '/api/verification/callback/discord',
      clientIdKey: 'discordClientId',
      clientSecretKey: 'discordClientSecret',
      extraOAuthParams: { prompt: 'consent' },
    },

    async fetchIdentity(accessToken) {
      return fetchDiscordIdentity(accessToken);
    },

    async afterLink(input, ctx) {
      if (input.sessionMode !== 'discord_role') {
        return;
      }

      if (!input.grantedScopes?.includes('guilds.members.read')) {
        throw new Error('Please try again and grant server membership access');
      }

      const encryptedToken = await encrypt(
        input.accessToken,
        ctx.encryptionSecret,
        DISCORD_TOKEN_PURPOSE
      );
      await ctx.convex.mutation(api.identitySync.storeDiscordToken, {
        apiSecret: ctx.apiSecret,
        externalAccountId: input.externalAccountId,
        discordAccessTokenEncrypted: encryptedToken,
        discordTokenExpiresAt: input.expiresAt ?? Date.now() + 7 * 24 * 60 * 60 * 1000,
      });

      const creatorAuthUserId = input.creatorAuthUserId ?? input.authUserId;
      const tenant = await ctx.convex.query(api.creatorProfiles.getCreatorProfile, {
        apiSecret: ctx.apiSecret,
        authUserId: creatorAuthUserId,
      });
      if (!tenant) {
        throw new Error('Tenant not found');
      }

      const policy = tenant.policy ?? {};
      const enabled = policy.enableDiscordRoleFromOtherServers === true;
      const allowedGuildIds = policy.allowedSourceGuildIds ?? [];
      if (!enabled || allowedGuildIds.length === 0) {
        return;
      }

      const rules = await ctx.convex.query(api.role_rules.getDiscordRoleRulesByTenant, {
        apiSecret: ctx.apiSecret,
        authUserId: creatorAuthUserId,
        sourceGuildIds: allowedGuildIds,
      });

      for (const rule of rules) {
        const { sourceGuildId, requiredRoleId, requiredRoleIds, requiredRoleMatchMode, productId } =
          rule;
        const requiredIds = requiredRoleIds ?? (requiredRoleId ? [requiredRoleId] : []);
        if (!sourceGuildId || requiredIds.length === 0) {
          continue;
        }

        const member = await fetchGuildMember(input.accessToken, sourceGuildId);
        const roles = member.roles ?? [];
        const matchAll = requiredRoleMatchMode === 'all';
        const hasRole = matchAll
          ? requiredIds.every((id: string) => roles.includes(id) || id === sourceGuildId)
          : requiredIds.some((id: string) => roles.includes(id) || id === sourceGuildId);

        if (!hasRole) {
          continue;
        }

        const sourceReference = productId ?? `discord_role:${sourceGuildId}:${requiredIds[0]}`;
        await ctx.convex.mutation(api.entitlements.grantEntitlement, {
          apiSecret: ctx.apiSecret,
          authUserId: creatorAuthUserId,
          subjectId: input.subjectId,
          productId,
          evidence: {
            provider: 'discord',
            sourceReference,
          },
        });
      }
    },
  };
}

export const buyerLink = createDiscordBuyerLinkPlugin();
