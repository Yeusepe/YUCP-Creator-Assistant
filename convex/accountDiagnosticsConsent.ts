import { ConvexError, v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { ApiActorBindingV, requireServiceActor } from './lib/apiActor';
import { requireApiSecret } from './lib/apiAuth';
import { getAuthenticatedAuthUser } from './lib/authUser';

const ChoiceV = v.union(v.literal('necessary-only'), v.literal('helpful-diagnostics'));

const DIAGNOSTICS_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ConsentV = v.object({
  choice: ChoiceV,
  decidedAt: v.number(),
  diagnosticsEnabled: v.boolean(),
  diagnosticsSessionId: v.union(v.null(), v.string()),
});

function requireSource(value: string): string {
  const source = value.trim();
  if (!source || source.length > 32 || !/^[a-z0-9-]+$/.test(source)) {
    throw new ConvexError('Diagnostics consent source is invalid');
  }
  return source;
}

function requireDiagnosticsSessionId(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!DIAGNOSTICS_SESSION_ID_PATTERN.test(value)) {
    throw new ConvexError('Diagnostics session ID is invalid');
  }
  return value.toLowerCase();
}

export const recordConsent = mutation({
  args: {
    choice: ChoiceV,
    diagnosticsSessionId: v.optional(v.string()),
    source: v.string(),
  },
  returns: ConsentV,
  handler: async (ctx, args) => {
    const authUser = await getAuthenticatedAuthUser(ctx);
    if (!authUser) {
      throw new ConvexError('Authentication is required');
    }
    const source = requireSource(args.source);
    const diagnosticsEnabled = args.choice === 'helpful-diagnostics';
    const diagnosticsSessionId = diagnosticsEnabled
      ? requireDiagnosticsSessionId(args.diagnosticsSessionId)
      : undefined;
    const now = Date.now();
    const existing = await ctx.db
      .query('account_diagnostics_consent')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', authUser.authUserId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        choice: args.choice,
        diagnosticsEnabled,
        diagnosticsSessionId,
        decidedAt: now,
        source,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert('account_diagnostics_consent', {
        authUserId: authUser.authUserId,
        choice: args.choice,
        decidedAt: now,
        diagnosticsEnabled,
        diagnosticsSessionId,
        source,
        updatedAt: now,
      });
    }

    return {
      choice: args.choice,
      decidedAt: now,
      diagnosticsEnabled,
      diagnosticsSessionId: diagnosticsSessionId ?? null,
    };
  },
});

export const getConsent = query({
  args: {},
  returns: v.union(v.null(), ConsentV),
  handler: async (ctx) => {
    const authUser = await getAuthenticatedAuthUser(ctx);
    if (!authUser) {
      return null;
    }
    const consent = await ctx.db
      .query('account_diagnostics_consent')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', authUser.authUserId))
      .first();
    return consent
      ? {
          choice: consent.choice,
          decidedAt: consent.decidedAt,
          diagnosticsEnabled: consent.diagnosticsEnabled,
          diagnosticsSessionId: consent.diagnosticsSessionId ?? null,
        }
      : null;
  },
});

export const getConsentForService = query({
  args: {
    actor: ApiActorBindingV,
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: ConsentV,
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireServiceActor(args.actor, ['downloads:service']);
    const consent = await ctx.db
      .query('account_diagnostics_consent')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();
    return consent
      ? {
          choice: consent.choice,
          decidedAt: consent.decidedAt,
          diagnosticsEnabled: consent.diagnosticsEnabled,
          diagnosticsSessionId: consent.diagnosticsSessionId ?? null,
        }
      : {
          choice: 'necessary-only' as const,
          decidedAt: 0,
          diagnosticsEnabled: false,
          diagnosticsSessionId: null,
        };
  },
});
