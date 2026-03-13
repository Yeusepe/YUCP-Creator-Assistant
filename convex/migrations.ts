/**
 * One-time data migrations.
 * Run with: npx convex run migrations:purgeLegacyTenantDocuments
 * Re-run until it returns { deleted: 0 }.
 */

import { internalMutation } from './_generated/server';

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
  'creator_provider_config',
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
        const hasAuthUserId =
          ('authUserId' in doc && doc.authUserId != null) ||
          ('ownerAuthUserId' in doc && (doc as any).ownerAuthUserId != null) ||
          ('submittedByAuthUserId' in doc && (doc as any).submittedByAuthUserId != null);
        const hasLegacyTenantId =
          ('tenantId' in doc && (doc as any).tenantId != null) ||
          ('ownerTenantId' in doc && (doc as any).ownerTenantId != null) ||
          ('submittedByTenantId' in doc && (doc as any).submittedByTenantId != null);
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
      if ((doc as any).submittedByTenantId != null && (doc as any).submittedByAuthUserId == null) {
        await ctx.db.delete(doc._id);
        deleted++;
      }
    }

    return { deleted };
  },
});
