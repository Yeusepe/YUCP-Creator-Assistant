/**
 * Dashboard Views — Session-authenticated Convex queries for the web dashboard.
 *
 * These queries use Better Auth session authentication (authComponent.getAuthUser),
 * making them safe to call directly from the browser via useConvexQuery. Unlike the
 * existing provider_connections queries that require requireApiSecret, these are
 * authenticated per-user and provide real-time reactivity via Convex's push model.
 *
 * Use these instead of the HTTP /api/connect/user/accounts and /api/connect/status
 * endpoints for volatile data that should update in real-time across browser tabs.
 */

import { v } from 'convex/values';
import { authComponent } from './auth';
import { query } from './_generated/server';

interface AuthUserRecord {
  id?: string;
}

const ConnectionSummaryV = v.object({
  id: v.id('provider_connections'),
  provider: v.string(),
  label: v.string(),
  connectionType: v.string(),
  status: v.string(),
  webhookConfigured: v.boolean(),
  hasApiKey: v.boolean(),
  hasAccessToken: v.boolean(),
  authUserId: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

// ─────────────────────────────────────────────────────────────────────────────
// listMyConnections — replaces GET /api/connect/user/accounts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List all active provider connections for the currently authenticated user.
 * Reactive: re-renders whenever provider_connections changes for this user.
 */
export const listMyConnections = query({
  args: {},
  returns: v.array(ConnectionSummaryV),
  handler: async (ctx) => {
    // biome-ignore lint/suspicious/noExplicitAny: Convex auth generic
    const authUser = (await authComponent.getAuthUser(ctx)) as AuthUserRecord | null;
    if (!authUser?.id) {
      return [];
    }

    const connections = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', authUser.id as string))
      .filter((q) => q.neq(q.field('status'), 'disconnected'))
      .collect();

    return connections.map((c) => ({
      id: c._id,
      provider: c.provider,
      label: c.label ?? `${c.provider} Connection`,
      connectionType: c.connectionType ?? 'setup',
      status: c.status ?? (c.webhookConfigured ? 'active' : 'disconnected'),
      webhookConfigured: c.webhookConfigured,
      hasApiKey: false,
      hasAccessToken: false,
      authUserId: c.authUserId,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// getMyConnectionStatus — replaces GET /api/connect/status
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get a map of which providers the authenticated user has active connections for.
 * Returns Record<string, boolean> e.g. { gumroad: true, jinxxy: false }.
 * Reactive: re-renders whenever provider_connections changes for this user.
 */
export const getMyConnectionStatus = query({
  args: {},
  returns: v.record(v.string(), v.boolean()),
  handler: async (ctx) => {
    // biome-ignore lint/suspicious/noExplicitAny: Convex auth generic
    const authUser = (await authComponent.getAuthUser(ctx)) as AuthUserRecord | null;
    if (!authUser?.id) {
      return {};
    }

    const connections = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', authUser.id as string))
      .filter((q) => q.neq(q.field('status'), 'disconnected'))
      .collect();

    const status: Record<string, boolean> = {};
    for (const c of connections) {
      if (c.provider) {
        status[c.provider] = true;
      }
    }
    return status;
  },
});
