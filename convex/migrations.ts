/**
 * One-time data migrations.
 * Run with: npx convex run migrations:purgeLegacyTenantDocuments
 * Re-run until it returns { deleted: 0 }.
 */

import { v } from 'convex/values';
import { internalMutation } from './_generated/server';

type LegacyMigrationDoc = Record<string, unknown>;

const LEGACY_TABLES = [
  'bindings',
  'verification_sessions',
  'entitlements',
  'guild_links',
  'role_rules',
  'download_routes',
  'download_artifacts',
  'unity_installations',
  'runtime_assertions',
  'outbox_jobs',
  'audit_events',
  'product_catalog',
  'purchase_facts',
  'provider_connections',
  'provider_credentials',
  'provider_connection_capabilities',
  'provider_catalog_mappings',
  'provider_transactions',
  'provider_memberships',
  'provider_licenses',
  'entitlement_evidence',
  'creator_oauth_apps',
  'manual_licenses',
  'webhook_events',
  'collaborator_invites',
  'collaborator_connections',
  'creator_profiles',
] as const;

/**
 * Delete up to 200 legacy tenant documents per table (plus up to 200
 * catalog_product_links) per call. Re-run until it returns { deleted: 0 }.
 */
export const purgeLegacyTenantDocuments = internalMutation({
  args: {},
  handler: async (ctx) => {
    let deleted = 0;
    const PER_TABLE = 200;

    for (const table of LEGACY_TABLES) {
      // Filter to only fetch docs that still have a legacy tenantId field,
      // so .take() selects from the right pool regardless of insertion order.
      const docs = await ctx.db
        .query(table)
        .filter((q) => q.neq(q.field('tenantId'), null))
        .take(PER_TABLE);
      for (const doc of docs) {
        const fields = doc as LegacyMigrationDoc;
        const hasAuthUserId =
          ('authUserId' in fields && fields.authUserId != null) ||
          ('ownerAuthUserId' in fields && fields.ownerAuthUserId != null) ||
          ('submittedByAuthUserId' in fields && fields.submittedByAuthUserId != null);
        const hasLegacyTenantId =
          ('tenantId' in fields && fields.tenantId != null) ||
          ('ownerTenantId' in fields && fields.ownerTenantId != null) ||
          ('submittedByTenantId' in fields && fields.submittedByTenantId != null);
        if (hasLegacyTenantId && !hasAuthUserId) {
          await ctx.db.delete(doc._id);
          deleted++;
        }
      }
    }

    // Also purge catalog_product_links with submittedByTenantId
    const catalogLinks = await ctx.db
      .query('catalog_product_links')
      .filter((q) => q.neq(q.field('submittedByTenantId'), null))
      .take(PER_TABLE);
    for (const doc of catalogLinks) {
      const fields = doc as LegacyMigrationDoc;
      if (fields.submittedByTenantId != null && fields.submittedByAuthUserId == null) {
        await ctx.db.delete(doc._id);
        deleted++;
      }
    }

    return { deleted };
  },
});

/**
 * Destructive helper for reset workflows.
 * Deletes provider connection rows and their provider-scoped dependents for one auth user.
 */
export const dangerouslyResetProviderDataForAuthUser = internalMutation({
  args: {
    authUserId: v.string(),
  },
  handler: async (ctx, args) => {
    const connections = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .collect();

    const connectionIds = new Set(connections.map((doc) => doc._id));

    const providerCredentials = [];
    const providerConnectionCapabilities = [];
    const providerCatalogMappings = [];
    const providerTransactions = [];
    const providerMemberships = [];
    const providerLicenses = [];

    for (const connection of connections) {
      providerCredentials.push(
        ...(await ctx.db
          .query('provider_credentials')
          .withIndex('by_connection', (q) => q.eq('providerConnectionId', connection._id))
          .collect())
      );
      providerConnectionCapabilities.push(
        ...(await ctx.db
          .query('provider_connection_capabilities')
          .withIndex('by_connection', (q) => q.eq('providerConnectionId', connection._id))
          .collect())
      );
      providerCatalogMappings.push(
        ...(await ctx.db
          .query('provider_catalog_mappings')
          .withIndex('by_connection', (q) => q.eq('providerConnectionId', connection._id))
          .collect())
      );
      providerTransactions.push(
        ...(await ctx.db
          .query('provider_transactions')
          .withIndex('by_connection', (q) => q.eq('providerConnectionId', connection._id))
          .collect())
      );
      providerMemberships.push(
        ...(await ctx.db
          .query('provider_memberships')
          .withIndex('by_connection', (q) => q.eq('providerConnectionId', connection._id))
          .collect())
      );
      providerLicenses.push(
        ...(await ctx.db
          .query('provider_licenses')
          .withIndex('by_connection', (q) => q.eq('providerConnectionId', connection._id))
          .collect())
      );
    }

    const transactionIds = new Set(providerTransactions.map((doc) => doc._id));
    const membershipIds = new Set(providerMemberships.map((doc) => doc._id));
    const licenseIds = new Set(providerLicenses.map((doc) => doc._id));

    const entitlementEvidence = (await ctx.db.query('entitlement_evidence').collect()).filter(
      (doc) =>
        doc.authUserId === args.authUserId ||
        (doc.providerConnectionId != null && connectionIds.has(doc.providerConnectionId)) ||
        (doc.transactionId != null && transactionIds.has(doc.transactionId)) ||
        (doc.membershipId != null && membershipIds.has(doc.membershipId)) ||
        (doc.licenseId != null && licenseIds.has(doc.licenseId))
    );

    const webhookEvents = await ctx.db
      .query('webhook_events')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .collect();

    let deletedEntitlementEvidence = 0;
    for (const doc of entitlementEvidence) {
      await ctx.db.delete(doc._id);
      deletedEntitlementEvidence++;
    }

    let deletedWebhookEvents = 0;
    for (const doc of webhookEvents) {
      if (doc.providerConnectionId == null || connectionIds.has(doc.providerConnectionId)) {
        await ctx.db.delete(doc._id);
        deletedWebhookEvents++;
      }
    }

    for (const doc of providerCredentials) {
      await ctx.db.delete(doc._id);
    }
    for (const doc of providerConnectionCapabilities) {
      await ctx.db.delete(doc._id);
    }
    for (const doc of providerCatalogMappings) {
      await ctx.db.delete(doc._id);
    }
    for (const doc of providerTransactions) {
      await ctx.db.delete(doc._id);
    }
    for (const doc of providerMemberships) {
      await ctx.db.delete(doc._id);
    }
    for (const doc of providerLicenses) {
      await ctx.db.delete(doc._id);
    }
    for (const doc of connections) {
      await ctx.db.delete(doc._id);
    }

    return {
      providerConnections: connections.length,
      providerCredentials: providerCredentials.length,
      providerConnectionCapabilities: providerConnectionCapabilities.length,
      providerCatalogMappings: providerCatalogMappings.length,
      providerTransactions: providerTransactions.length,
      providerMemberships: providerMemberships.length,
      providerLicenses: providerLicenses.length,
      entitlementEvidence: deletedEntitlementEvidence,
      webhookEvents: deletedWebhookEvents,
    };
  },
});
