/**
 * User portal Convex functions.
 *
 * These functions expose user-scoped data to the YUCP API layer without
 * going through provider-specific or creator-scoped code paths. They use
 * the betterAuth component adapter to access OAuth token and consent tables
 * that live in the betterAuth Convex component namespace.
 */

import { ConvexError, v } from 'convex/values';
import { components } from './_generated/api';
import { mutation, query } from './_generated/server';
import { requireApiSecret } from './lib/apiAuth';
import {
  type BetterAuthPageResult,
  buildBetterAuthEqualityWhere,
  buildOAuthConsentLookupWhere,
  getBetterAuthPage,
} from './lib/betterAuthAdapter';

// ============================================================================
// OAuth Grants
// ============================================================================

/**
 * Returns the list of OAuth consents (authorized apps) for a given user.
 * Each record includes the app name resolved from the associated oauthClient.
 */
export const listOAuthGrantsForUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const consentResult = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: 'oauthConsent',
      where: buildBetterAuthEqualityWhere([{ field: 'userId', value: args.authUserId }]),
      limit: 100,
      paginationOpts: { cursor: null, numItems: 100 },
    })) as BetterAuthPageResult<{
      _id: string;
      clientId: string;
      userId?: string | null;
      scopes: string[];
      createdAt?: number | null;
      updatedAt?: number | null;
    }>;

    const consents = getBetterAuthPage(consentResult);

    if (consents.length === 0) {
      return [];
    }

    const clientIds = [...new Set(consents.map((c) => c.clientId))];

    const clientRecords = (await Promise.all(
      clientIds.map((clientId) =>
        ctx.runQuery(components.betterAuth.adapter.findOne, {
          model: 'oauthClient',
          where: buildBetterAuthEqualityWhere([{ field: 'clientId', value: clientId }]),
        })
      )
    )) as Array<{ clientId: string; name?: string | null } | null>;

    const clientMap = new Map(
      clientRecords
        .filter((c): c is { clientId: string; name?: string | null } => !!c)
        .map((c) => [c.clientId, c])
    );

    return consents.map((consent) => {
      const client = clientMap.get(consent.clientId);
      return {
        consentId: consent._id,
        clientId: consent.clientId,
        appName: client?.name ?? consent.clientId,
        scopes: consent.scopes ?? [],
        grantedAt: consent.createdAt ?? null,
        updatedAt: consent.updatedAt ?? null,
      };
    });
  },
});

/**
 * Revokes an OAuth grant for a user.
 *
 * Verifies that the consent record belongs to the requesting user before
 * deleting the consent, all access tokens, and all refresh tokens associated
 * with the client+user pair.
 */
export const revokeOAuthGrant = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    consentId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const consent = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'oauthConsent',
      where: buildOAuthConsentLookupWhere(args.authUserId, args.consentId),
    })) as { _id: string; clientId: string; userId?: string | null } | null;

    if (!consent) {
      throw new ConvexError('OAuth consent not found');
    }

    if (consent.userId !== args.authUserId) {
      throw new ConvexError('Unauthorized: consent does not belong to this user');
    }

    const clientId = consent.clientId;

    await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: {
        model: 'oauthConsent',
        where: buildBetterAuthEqualityWhere([
          { field: 'userId', value: args.authUserId },
          { field: 'clientId', value: clientId },
        ]),
      },
      paginationOpts: { cursor: null, numItems: 10 },
    } as any);

    await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: {
        model: 'oauthAccessToken',
        where: buildBetterAuthEqualityWhere([
          { field: 'clientId', value: clientId },
          { field: 'userId', value: args.authUserId },
        ]),
      },
      paginationOpts: { cursor: null, numItems: 100 },
    } as any);

    await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: {
        model: 'oauthRefreshToken',
        where: buildBetterAuthEqualityWhere([
          { field: 'clientId', value: clientId },
          { field: 'userId', value: args.authUserId },
        ]),
      },
      paginationOpts: { cursor: null, numItems: 100 },
    } as any);

    return { success: true };
  },
});

// ============================================================================
// Account Deletion
// ============================================================================

/**
 * Records a GDPR account deletion request.
 *
 * This does NOT immediately delete the account. A background process handles
 * the 30-day Article 17 deletion window. Returns early if a pending request
 * already exists.
 */
export const requestAccountDeletion = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const existing = await ctx.db
      .query('account_deletion_requests')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .filter((q) =>
        q.or(q.eq(q.field('status'), 'pending'), q.eq(q.field('status'), 'processing'))
      )
      .first();

    if (existing) {
      return {
        alreadyRequested: true,
        requestId: existing._id,
        requestedAt: existing.requestedAt,
      };
    }

    const now = Date.now();
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

    const requestId = await ctx.db.insert('account_deletion_requests', {
      authUserId: args.authUserId,
      requestedAt: now,
      deadlineAt: now + THIRTY_DAYS_MS,
      status: 'pending',
    });

    return {
      alreadyRequested: false,
      requestId,
      requestedAt: now,
    };
  },
});

/**
 * Revokes all OAuth grants (consents, access tokens, refresh tokens) for a user.
 * Used as part of account deletion.
 */
export const revokeAllOAuthGrantsForUser = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: {
        model: 'oauthConsent',
        where: buildBetterAuthEqualityWhere([{ field: 'userId', value: args.authUserId }]),
      },
      paginationOpts: { cursor: null, numItems: 1000 },
    } as any);

    await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: {
        model: 'oauthAccessToken',
        where: buildBetterAuthEqualityWhere([{ field: 'userId', value: args.authUserId }]),
      },
      paginationOpts: { cursor: null, numItems: 1000 },
    } as any);

    await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: {
        model: 'oauthRefreshToken',
        where: buildBetterAuthEqualityWhere([{ field: 'userId', value: args.authUserId }]),
      },
      paginationOpts: { cursor: null, numItems: 1000 },
    } as any);

    return { success: true };
  },
});
