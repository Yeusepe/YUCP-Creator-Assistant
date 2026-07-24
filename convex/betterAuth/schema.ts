import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { tables as generatedTables } from './schema.generated';

/**
 * Transitional Better Auth 1.6 to 1.7 storage schema.
 *
 * Keep legacy fields optional during the production backfill.
 * Remove this overlay only after the cleanup audit reports zero records.
 *
 * Convex migration guidance:
 * https://docs.convex.dev/production/overview#making-safe-changes
 */
export const tables = {
  ...generatedTables,
  account: defineTable({
    accountId: v.optional(v.string()),
    issuer: v.optional(v.string()),
    providerAccountId: v.optional(v.string()),
    providerId: v.string(),
    userId: v.string(),
    accessToken: v.optional(v.union(v.null(), v.string())),
    refreshToken: v.optional(v.union(v.null(), v.string())),
    idToken: v.optional(v.union(v.null(), v.string())),
    accessTokenExpiresAt: v.optional(v.union(v.null(), v.number())),
    refreshTokenExpiresAt: v.optional(v.union(v.null(), v.number())),
    scope: v.optional(v.union(v.null(), v.string())),
    password: v.optional(v.union(v.null(), v.string())),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('accountId', ['accountId'])
    .index('accountId_providerId', ['accountId', 'providerId'])
    .index('issuer_providerAccountId', ['issuer', 'providerAccountId'])
    .index('providerId_userId', ['providerId', 'userId'])
    .index('userId', ['userId']),
  apikey: defineTable({
    configId: v.optional(v.union(v.null(), v.string())),
    name: v.optional(v.union(v.null(), v.string())),
    start: v.optional(v.union(v.null(), v.string())),
    referenceId: v.optional(v.union(v.null(), v.string())),
    prefix: v.optional(v.union(v.null(), v.string())),
    key: v.string(),
    userId: v.optional(v.string()),
    refillInterval: v.optional(v.union(v.null(), v.number())),
    refillAmount: v.optional(v.union(v.null(), v.number())),
    lastRefillAt: v.optional(v.union(v.null(), v.number())),
    enabled: v.optional(v.union(v.null(), v.boolean())),
    rateLimitEnabled: v.optional(v.union(v.null(), v.boolean())),
    rateLimitTimeWindow: v.optional(v.union(v.null(), v.number())),
    rateLimitMax: v.optional(v.union(v.null(), v.number())),
    requestCount: v.optional(v.union(v.null(), v.number())),
    remaining: v.optional(v.union(v.null(), v.number())),
    lastRequest: v.optional(v.union(v.null(), v.number())),
    expiresAt: v.optional(v.union(v.null(), v.number())),
    createdAt: v.number(),
    updatedAt: v.number(),
    permissions: v.optional(v.union(v.null(), v.string())),
    metadata: v.optional(v.union(v.null(), v.string())),
  })
    .index('configId', ['configId'])
    .index('expiresAt', ['expiresAt'])
    .index('referenceId', ['referenceId'])
    .index('userId', ['userId']),
};

const schema = defineSchema(tables);

export default schema;
