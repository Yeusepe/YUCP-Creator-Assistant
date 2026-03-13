/**
 * RFC 8252 loopback redirect URI proxy, server-side session storage.
 *
 * Stores {state → originalRedirectUri} for 10 minutes while the OAuth flow
 * runs. The httpAction in http.ts calls these to proxy ephemeral loopback
 * ports, since Better Auth's oauthProvider does not yet support wildcard
 * ports per RFC 8252 §7.3.
 *
 * Reference: https://github.com/better-auth/better-auth/issues/8426
 * RFC 8252:  https://datatracker.ietf.org/doc/html/rfc8252#section-7.3
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';

const TTL_MS = 10 * 60 * 1000; // 10 minutes

export const storeSession = internalMutation({
  args: {
    oauthState: v.string(),
    originalRedirectUri: v.string(),
  },
  handler: async (ctx, args) => {
    // Upsert: if the state was already stored (retry), overwrite
    const existing = await ctx.db
      .query('oauth_loopback_sessions')
      .withIndex('by_oauth_state', (q) => q.eq('oauthState', args.oauthState))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        originalRedirectUri: args.originalRedirectUri,
        createdAt: Date.now(),
      });
    } else {
      await ctx.db.insert('oauth_loopback_sessions', {
        oauthState: args.oauthState,
        originalRedirectUri: args.originalRedirectUri,
        createdAt: Date.now(),
      });
    }
  },
});

export const getSession = internalQuery({
  args: { oauthState: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query('oauth_loopback_sessions')
      .withIndex('by_oauth_state', (q) => q.eq('oauthState', args.oauthState))
      .first();
    if (!session) return null;
    // Treat expired sessions as not found
    if (Date.now() - session.createdAt > TTL_MS) return null;
    return session;
  },
});

export const deleteSession = internalMutation({
  args: { oauthState: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query('oauth_loopback_sessions')
      .withIndex('by_oauth_state', (q) => q.eq('oauthState', args.oauthState))
      .first();
    if (session) await ctx.db.delete(session._id);
  },
});

/**
 * Atomically read and delete a loopback session in a single transaction.
 * Prevents TOCTOU race where two concurrent requests could both see the same session.
 * Returns null if session is missing or expired.
 */
export const consumeSession = internalMutation({
  args: { oauthState: v.string() },
  returns: v.union(
    v.null(),
    v.object({ oauthState: v.string(), originalRedirectUri: v.string(), createdAt: v.number() })
  ),
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query('oauth_loopback_sessions')
      .withIndex('by_oauth_state', (q) => q.eq('oauthState', args.oauthState))
      .first();
    if (!session) return null;
    if (Date.now() - session.createdAt > TTL_MS) {
      await ctx.db.delete(session._id);
      return null;
    }
    await ctx.db.delete(session._id);
    return {
      oauthState: session.oauthState,
      originalRedirectUri: session.originalRedirectUri,
      createdAt: session.createdAt,
    };
  },
});
