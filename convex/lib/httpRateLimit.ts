/**
 * HTTP endpoint rate limiting using a fixed-window counter stored in Convex.
 *
 * Each request increments a counter for the current time window.  If the
 * counter exceeds the limit the request is rejected.  Old windows are pruned
 * lazily on each write so the table stays small.
 *
 * Usage (inside an httpAction handler):
 *   const limited = await ctx.runMutation(internal.lib.httpRateLimit.checkAndIncrement, {
 *     key: `fingerprint:${hash}`,
 *     limit: 10,
 *     windowMs: 60_000,
 *   });
 *   if (limited) return errorResponse('Too many requests', 429);
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';

/** Window older than this will be pruned on write (2 × max window size). */
const PRUNE_OLDER_THAN_MS = 10 * 60 * 1000;

export const checkAndIncrement = internalMutation({
  args: {
    /** Opaque key to rate-limit on (e.g. "fingerprint:<hex>" or "ip:<addr>"). */
    key: v.string(),
    /** Maximum requests allowed within the window. */
    limit: v.number(),
    /** Window duration in milliseconds (e.g. 60_000 for 1 minute). */
    windowMs: v.number(),
  },
  returns: v.boolean(), // true = rate limit exceeded, caller should return 429
  handler: async (ctx, args) => {
    const now = Date.now();
    const windowStart = Math.floor(now / args.windowMs) * args.windowMs;

    // Prune expired windows lazily to keep the table bounded.
    const cutoff = now - PRUNE_OLDER_THAN_MS;
    const old = await ctx.db
      .query('http_rate_limits')
      .withIndex('by_window_start', (q) => q.lt('windowStart', cutoff))
      .take(50);
    for (const doc of old) {
      await ctx.db.delete(doc._id);
    }

    // Find or create the counter for the current window.
    const existing = await ctx.db
      .query('http_rate_limits')
      .withIndex('by_key_window', (q) => q.eq('key', args.key).eq('windowStart', windowStart))
      .first();

    if (!existing) {
      await ctx.db.insert('http_rate_limits', { key: args.key, windowStart, count: 1 });
      return false;
    }

    if (existing.count >= args.limit) {
      return true; // exceeded, do NOT increment further
    }

    await ctx.db.patch(existing._id, { count: existing.count + 1 });
    return false;
  },
});
