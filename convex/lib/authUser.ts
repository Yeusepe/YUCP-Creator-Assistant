import { components } from '../_generated/api';
import type { MutationCtx, QueryCtx } from '../_generated/server';

type AuthResolverCtx = Pick<QueryCtx, 'auth' | 'runQuery'> | Pick<MutationCtx, 'auth' | 'runQuery'>;

interface BetterAuthUserRecord {
  _id?: string;
  id?: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
}

export interface AuthenticatedAuthUser {
  authUserId: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

function serializeAuthUserError(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    message: String(error),
  };
}

function getNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeBetterAuthUserId(user: BetterAuthUserRecord | null, fallbackId: string): string | null {
  return getNonEmptyString(user?.id) ?? getNonEmptyString(user?._id) ?? getNonEmptyString(fallbackId);
}

/**
 * Mirrors the Better Auth Convex client flow from
 * https://raw.githubusercontent.com/get-convex/better-auth/main/src/client/create-client.ts
 * but normalizes the returned user id for this codebase and downgrades malformed
 * auth identities to "unauthenticated" instead of surfacing generic server errors.
 */
export async function getAuthenticatedAuthUser(
  ctx: AuthResolverCtx
): Promise<AuthenticatedAuthUser | null> {
  const identity = await ctx.auth.getUserIdentity();
  const authUserId = getNonEmptyString(identity?.subject);
  const sessionId = getNonEmptyString((identity as { sessionId?: unknown } | null)?.sessionId);

  if (!authUserId || !sessionId) {
    return null;
  }

  try {
    const session = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'session',
      where: [
        {
          field: '_id',
          value: sessionId,
        },
        {
          field: 'expiresAt',
          operator: 'gt',
          value: Date.now(),
        },
      ],
    })) as { _id?: string } | null;

    if (!session) {
      return null;
    }

    const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: [
        {
          field: '_id',
          value: authUserId,
        },
      ],
    })) as BetterAuthUserRecord | null;

    const normalizedAuthUserId = normalizeBetterAuthUserId(user, authUserId);
    if (!normalizedAuthUserId) {
      return null;
    }

    return {
      authUserId: normalizedAuthUserId,
      name: user?.name ?? null,
      email: user?.email ?? null,
      image: user?.image ?? null,
    };
  } catch (error) {
    console.error('[convex] authenticated auth user resolution failed', {
      phase: 'convex-authenticated-auth-user',
      error: serializeAuthUserError(error),
    });
    return null;
  }
}
