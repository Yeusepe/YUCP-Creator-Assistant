/**
 * Webhook Subscriptions — outbound delivery endpoint registrations.
 *
 * Signing secrets are stored encrypted (AES-256-GCM + HKDF). The API server
 * encrypts before writing and decrypts after reading. This layer never
 * handles plaintext signing secrets — signingSecretEnc is never returned
 * by public queries.
 */

import { redactForLogging } from '@yucp/shared/logging/redaction';
import { v } from 'convex/values';
import { internalQuery, mutation, query } from './_generated/server';
import { requireApiSecret } from './lib/apiAuth';

/** Strip signingSecretEnc from a subscription doc before returning it publicly. */
export function sanitizeWebhookSubscriptionForPublicRead(
  doc: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(doc)
      .filter(([key]) => key !== 'signingSecretEnc')
      .map(([key, value]) => [key, redactForLogging(value)] as const)
  );
}

// ---------------------------------------------------------------------------
// Internal queries
// ---------------------------------------------------------------------------

/**
 * Get a subscription by ID including signingSecretEnc — for the delivery
 * worker only. Never expose this to public API callers.
 */
export const getByIdInternal = internalQuery({
  args: {
    subscriptionId: v.id('webhook_subscriptions'),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.subscriptionId);
  },
});

// ---------------------------------------------------------------------------
// Public queries
// ---------------------------------------------------------------------------

/** List subscriptions for a creator. signingSecretEnc is never returned. */
export const list = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    enabled: v.optional(v.boolean()),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const enabled = args.enabled;
    const docs =
      typeof enabled === 'boolean'
        ? await ctx.db
            .query('webhook_subscriptions')
            .withIndex('by_auth_user_enabled', (q) =>
              q.eq('authUserId', args.authUserId).eq('enabled', enabled)
            )
            .collect()
        : await ctx.db
            .query('webhook_subscriptions')
            .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
            .collect();

    return docs.map((d) => sanitizeWebhookSubscriptionForPublicRead(d as Record<string, unknown>));
  },
});

/**
 * Get a single subscription by ID. Returns null if not found or authUserId
 * does not match. signingSecretEnc is never returned.
 */
export const getById = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    subscriptionId: v.id('webhook_subscriptions'),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const doc = await ctx.db.get(args.subscriptionId);
    if (!doc || doc.authUserId !== args.authUserId) return null;
    return sanitizeWebhookSubscriptionForPublicRead(doc as Record<string, unknown>);
  },
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Create a new webhook subscription. Returns the new subscription ID. */
export const create = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    url: v.string(),
    events: v.array(v.string()),
    description: v.optional(v.string()),
    enabled: v.optional(v.boolean()),
    signingSecretEnc: v.string(),
    signingSecretPrefix: v.string(),
  },
  returns: v.id('webhook_subscriptions'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    return await ctx.db.insert('webhook_subscriptions', {
      authUserId: args.authUserId,
      url: args.url,
      events: args.events,
      enabled: args.enabled ?? true,
      description: args.description,
      signingSecretEnc: args.signingSecretEnc,
      signingSecretPrefix: args.signingSecretPrefix,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Update mutable fields on a subscription. Ownership is verified.
 * Returns the updated doc without signingSecretEnc.
 */
export const update = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    subscriptionId: v.id('webhook_subscriptions'),
    url: v.optional(v.string()),
    events: v.optional(v.array(v.string())),
    description: v.optional(v.string()),
    enabled: v.optional(v.boolean()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const existing = await ctx.db.get(args.subscriptionId);
    if (!existing || existing.authUserId !== args.authUserId) {
      throw new Error('Subscription not found or access denied');
    }

    const patch: {
      updatedAt: number;
      url?: string;
      events?: string[];
      description?: string;
      enabled?: boolean;
    } = { updatedAt: Date.now() };

    if (args.url !== undefined) patch.url = args.url;
    if (args.events !== undefined) patch.events = args.events;
    if (args.description !== undefined) patch.description = args.description;
    if (args.enabled !== undefined) patch.enabled = args.enabled;

    await ctx.db.patch(args.subscriptionId, patch);

    const updated = await ctx.db.get(args.subscriptionId);
    if (!updated) throw new Error('Subscription not found after update');
    return sanitizeWebhookSubscriptionForPublicRead(updated as Record<string, unknown>);
  },
});

/**
 * Delete a subscription and all its delivery records. Ownership is verified.
 */
export const deleteSubscription = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    subscriptionId: v.id('webhook_subscriptions'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const existing = await ctx.db.get(args.subscriptionId);
    if (!existing || existing.authUserId !== args.authUserId) {
      throw new Error('Subscription not found or access denied');
    }

    const deliveries = await ctx.db
      .query('webhook_deliveries')
      .withIndex('by_subscription', (q) => q.eq('subscriptionId', args.subscriptionId))
      .collect();

    for (const delivery of deliveries) {
      await ctx.db.delete(delivery._id);
    }

    await ctx.db.delete(args.subscriptionId);
    return null;
  },
});

/**
 * Rotate the signing secret. Ownership is verified.
 * Returns the updated doc without signingSecretEnc.
 */
export const rotateSecret = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    subscriptionId: v.id('webhook_subscriptions'),
    newSigningSecretEnc: v.string(),
    newSigningSecretPrefix: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const existing = await ctx.db.get(args.subscriptionId);
    if (!existing || existing.authUserId !== args.authUserId) {
      throw new Error('Subscription not found or access denied');
    }

    await ctx.db.patch(args.subscriptionId, {
      signingSecretEnc: args.newSigningSecretEnc,
      signingSecretPrefix: args.newSigningSecretPrefix,
      updatedAt: Date.now(),
    });

    const updated = await ctx.db.get(args.subscriptionId);
    if (!updated) throw new Error('Subscription not found after rotate');
    return sanitizeWebhookSubscriptionForPublicRead(updated as Record<string, unknown>);
  },
});
