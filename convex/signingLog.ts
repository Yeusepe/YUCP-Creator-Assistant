/**
 * YUCP Signing Log — Layer 2 defense.
 *
 * Append-only transparency log recording every (contentHash, packageId, identity) triple.
 * If the same content hash is submitted by a different YUCP user, a conflict is detected
 * and the signing endpoint returns IDENTITY_CONFLICT — blocking the re-sign.
 *
 * Identity is anchored to the Better Auth user ID (yucpUserId), not to any specific
 * storefront — so this works regardless of which stores a creator connects.
 *
 * Design inspired by:
 *   Sigstore Rekor (append-only, tamper-evident)  https://docs.sigstore.dev/logging/overview/
 *   Certificate Transparency (RFC 6962)           https://www.rfc-editor.org/rfc/rfc6962
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

export const getEntry = internalQuery({
  args: { contentHash: v.string(), packageId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('signing_log')
      .withIndex('by_content_and_package', (q) =>
        q.eq('contentHash', args.contentHash).eq('packageId', args.packageId),
      )
      .first();
  },
});

export const getEntriesByContentHash = internalQuery({
  args: { contentHash: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('signing_log')
      .withIndex('by_content_hash', (q) => q.eq('contentHash', args.contentHash))
      .collect();
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────────────────────────────────────

export type WriteEntryResult =
  | { written: true; conflict: false }
  | { written: false; conflict: false }  // Same identity, same content: no-op
  | { written: false; conflict: true; existingYucpUserId: string; existingPublisherId: string };

export const writeEntry = internalMutation({
  args: {
    contentHash: v.string(),
    packageId: v.string(),
    publisherId: v.string(),
    /** Better Auth user ID of the signer */
    yucpUserId: v.string(),
    certNonce: v.string(),
    packageVersion: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<WriteEntryResult> => {
    const existing = await ctx.db
      .query('signing_log')
      .withIndex('by_content_and_package', (q) =>
        q.eq('contentHash', args.contentHash).eq('packageId', args.packageId),
      )
      .first();

    if (existing) {
      if (existing.yucpUserId !== args.yucpUserId) {
        // Same content, different identity → impersonation or re-sign attack
        return {
          written: false,
          conflict: true,
          existingYucpUserId: existing.yucpUserId,
          existingPublisherId: existing.publisherId,
        };
      }
      // Same identity, same content → legitimate re-sign (key rotation, etc.) — no-op
      return { written: false, conflict: false };
    }

    await ctx.db.insert('signing_log', {
      contentHash: args.contentHash,
      packageId: args.packageId,
      publisherId: args.publisherId,
      yucpUserId: args.yucpUserId,
      certNonce: args.certNonce,
      packageVersion: args.packageVersion,
      signedAt: Date.now(),
      conflictDetected: false,
    });
    return { written: true, conflict: false };
  },
});
