/**
 * Dashboard Views — Session-authenticated Convex queries for the web dashboard.
 *
 * These queries use Better Auth session authentication via a shared resolver,
 * making them safe to call directly from the browser via useConvexQuery. Unlike the
 * existing provider_connections queries that require requireApiSecret, these are
 * authenticated per-user and provide real-time reactivity via Convex's push model.
 *
 * Use these instead of the HTTP /api/connect/user/accounts and /api/connect/status
 * endpoints for volatile data that should update in real-time across browser tabs.
 */

import { v } from 'convex/values';
import { query } from './_generated/server';
import { getAuthenticatedAuthUser } from './lib/authUser';

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
    const authUser = await getAuthenticatedAuthUser(ctx);
    if (!authUser) {
      return [];
    }

    const connections = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', authUser.authUserId))
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
    const authUser = await getAuthenticatedAuthUser(ctx);
    if (!authUser) {
      return {};
    }

    const connections = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', authUser.authUserId))
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

// ─────────────────────────────────────────────────────────────────────────────
// getMyDashboardStats — replaces getStatsOverviewExtended for browser auth
// ─────────────────────────────────────────────────────────────────────────────

const DashboardStatsV = v.object({
  totalVerified: v.number(),
  totalProducts: v.number(),
  recent24h: v.number(),
  recent7d: v.number(),
  recent30d: v.number(),
  totalLicenses: v.number(),
  activeLicenses: v.number(),
});

/**
 * Aggregated dashboard stats for the currently authenticated user.
 * Combines entitlement stats (verified subjects, products, recent activity)
 * with manual license counts. Reactive: re-renders when entitlements,
 * subjects, or manual_licenses change for this user.
 */
export const getMyDashboardStats = query({
  args: {},
  returns: DashboardStatsV,
  handler: async (ctx) => {
    const authUser = await getAuthenticatedAuthUser(ctx);
    if (!authUser) {
      return {
        totalVerified: 0,
        totalProducts: 0,
        recent24h: 0,
        recent7d: 0,
        recent30d: 0,
        totalLicenses: 0,
        activeLicenses: 0,
      };
    }

    // --- entitlement stats (mirrors listActiveEntitlementsForActiveSubjects) ---
    const activeEntitlements = await ctx.db
      .query('entitlements')
      .withIndex('by_auth_user_status', (q) =>
        q.eq('authUserId', authUser.authUserId).eq('status', 'active')
      )
      .take(1000);

    const activeSubjectIds = new Map(
      await Promise.all(
        [...new Set(activeEntitlements.map((entitlement) => entitlement.subjectId))].map(
          async (subjectId) => {
            const subject = await ctx.db.get(subjectId);
            return [subjectId, subject?.status === 'active'] as const;
          }
        )
      )
    );
    const filtered = activeEntitlements.filter((entitlement) =>
      activeSubjectIds.get(entitlement.subjectId)
    );

    const uniqueSubjects = new Set(filtered.map((e) => e.subjectId));

    // Count products from role_rules (creator's configured product→role mappings),
    // not from entitlements, so the stat reflects "how many products I have set up"
    // rather than "how many products have been purchased so far."
    const roleRules = await ctx.db
      .query('role_rules')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', authUser.authUserId))
      .collect();
    const uniqueProducts = new Set(roleRules.filter((r) => r.enabled).map((r) => r.productId));

    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

    const recent24h = filtered.filter((e) => e.grantedAt >= oneDayAgo).length;
    const recent7d = filtered.filter((e) => e.grantedAt >= sevenDaysAgo).length;
    const recent30d = filtered.filter((e) => e.grantedAt >= thirtyDaysAgo).length;

    // --- manual license stats ---
    const licenses = await ctx.db
      .query('manual_licenses')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', authUser.authUserId))
      .collect();

    const totalLicenses = licenses.length;
    const activeLicenses = licenses.filter((l) => l.status === 'active').length;

    return {
      totalVerified: uniqueSubjects.size,
      totalProducts: uniqueProducts.size,
      recent24h,
      recent7d,
      recent30d,
      totalLicenses,
      activeLicenses,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// listMyRecentActivity — browser-auth audit event feed
// ─────────────────────────────────────────────────────────────────────────────

const AuditEventSummaryV = v.object({
  eventType: v.string(),
  actorType: v.string(),
  actorId: v.optional(v.string()),
  metadata: v.optional(v.any()),
  createdAt: v.number(),
});

/**
 * Most recent audit events for the currently authenticated user.
 * Returns the last 20 events sorted newest-first, suitable for an
 * activity feed widget. Reactive: re-renders when audit_events change
 * for this user.
 */
export const listMyRecentActivity = query({
  args: {},
  returns: v.array(AuditEventSummaryV),
  handler: async (ctx) => {
    const authUser = await getAuthenticatedAuthUser(ctx);
    if (!authUser) {
      return [];
    }

    const events = await ctx.db
      .query('audit_events')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', authUser.authUserId))
      .order('desc')
      .take(20);

    return events.map((e) => ({
      eventType: e.eventType,
      actorType: e.actorType,
      actorId: e.actorId,
      metadata: e.metadata,
      createdAt: e.createdAt,
    }));
  },
});
