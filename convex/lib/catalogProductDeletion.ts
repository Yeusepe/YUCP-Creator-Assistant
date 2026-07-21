import type { GenericQueryCtx } from 'convex/server';
import type { DataModel, Id } from '../_generated/dataModel';

type DatabaseReader = GenericQueryCtx<DataModel>['db'];

export const PRODUCT_DELETE_BLOCKED_REASON =
  'Product has package, role, entitlement, or tier history and cannot be deleted.';

export async function inspectCatalogProductDeletionDependencies(
  db: DatabaseReader,
  catalogProductId: Id<'product_catalog'>
) {
  const [roleRule, entitlement, catalogTiers, packageVersion] = await Promise.all([
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
      .first(),
  ]);

  return { roleRule, entitlement, catalogTiers, packageVersion };
}

export function getCatalogProductDeleteBlockedReason(
  dependencies: Awaited<ReturnType<typeof inspectCatalogProductDeletionDependencies>>
): string | undefined {
  return dependencies.roleRule ||
    dependencies.entitlement ||
    dependencies.catalogTiers.length > 0 ||
    dependencies.packageVersion
    ? PRODUCT_DELETE_BLOCKED_REASON
    : undefined;
}
