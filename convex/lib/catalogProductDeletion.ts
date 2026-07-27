import type { GenericQueryCtx } from 'convex/server';
import type { DataModel, Id } from '../_generated/dataModel';

type DatabaseReader = GenericQueryCtx<DataModel>['db'];

export const PRODUCT_DELETE_BLOCKED_REASON =
  'Product has package, role, entitlement, or tier history and cannot be deleted.';

export async function inspectCatalogProductDeletionDependencies(
  db: DatabaseReader,
  catalogProductId: Id<'product_catalog'>
) {
  const [product, roleRule, entitlement, catalogTiers, packageVersions, activePackageBinding] =
    await Promise.all([
      db.get(catalogProductId),
      db
        .query('role_rules')
        .withIndex('by_catalog_product', (q) => q.eq('catalogProductId', catalogProductId))
        .first(),
      db
        .query('entitlements')
        .withIndex('by_catalog_product', (q) => q.eq('catalogProductId', catalogProductId))
        .first(),
      db
        .query('catalog_tiers')
        .withIndex('by_catalog_product', (q) => q.eq('catalogProductId', catalogProductId))
        .collect(),
      db
        .query('package_versions_ref')
        .withIndex('by_catalog_product', (q) => q.eq('catalogProductId', catalogProductId))
        .collect(),
      db
        .query('package_catalog_bindings')
        .withIndex('by_catalog_product_status', (q) =>
          q.eq('catalogProductId', catalogProductId).eq('status', 'active')
        )
        .first(),
    ]);
  const packageEdition = product
    ? (
        await db
          .query('package_editions')
          .withIndex('by_creator_package', (q) => q.eq('creatorAuthUserId', product.authUserId))
          .collect()
      ).find(
        (edition) =>
          edition.catalogProductIds.some((candidate) => candidate === catalogProductId) ||
          catalogTiers.some((tier) =>
            edition.catalogTierIds.some((candidate) => candidate === tier._id)
          )
      )
    : undefined;

  return {
    activePackageBinding,
    catalogTiers,
    entitlement,
    packageEdition,
    packageVersions,
    roleRule,
  };
}

export function getCatalogProductDeleteBlockedReason(
  dependencies: Awaited<ReturnType<typeof inspectCatalogProductDeletionDependencies>>
): string | undefined {
  return dependencies.roleRule ||
    dependencies.entitlement ||
    dependencies.activePackageBinding ||
    dependencies.packageEdition ||
    dependencies.catalogTiers.length > 0 ||
    dependencies.packageVersions.length > 0
    ? PRODUCT_DELETE_BLOCKED_REASON
    : undefined;
}
