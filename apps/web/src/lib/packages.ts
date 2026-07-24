import { resolveComparableYucpAliasIdsFromCatalogProduct } from '@yucp/shared';
import { apiClient } from '@/api/client';

export interface CreatorCatalogTierSummary {
  _id: string;
  catalogProductId?: string;
  provider: string;
  providerTierRef: string;
  displayName: string;
  description?: string;
  amountCents?: number;
  currency?: string;
  status: 'active' | 'archived';
  createdAt: number;
  updatedAt: number;
}

export interface CreatorCatalogStorefrontSummary {
  catalogProductId: string;
  productId: string;
  provider: string;
  providerProductRef: string;
  displayName?: string;
  canonicalSlug?: string;
  thumbnailUrl?: string;
}

export interface CreatorPackageProductSummary {
  _id: string;
  aliasId?: string;
  aliases?: string[];
  canonicalSlug?: string;
  catalogProductIds?: string[];
  catalogTiers: CreatorCatalogTierSummary[];
  displayName?: string;
  thumbnailUrl?: string;
  packageId?: string;
  productId: string;
  provider: string;
  providerProductRef: string;
  status: 'active' | 'archived';
  storefronts?: CreatorCatalogStorefrontSummary[];
  supportsAutoDiscovery: boolean;
  createdAt: number;
  updatedAt: number;
  canArchive: boolean;
  canRestore: boolean;
  canDelete: boolean;
  deleteBlockedReason?: string;
}

export interface CreatorPackageProductListPage {
  data: CreatorPackageProductSummary[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface CreatorPackageProductListOptions {
  configured?: boolean;
  cursor?: string;
  limit?: number;
}

export interface CreatorPackagePickerProduct {
  identityKey: string;
  products: CreatorPackageProductSummary[];
}

const CREATOR_PACKAGES_PATH = '/api/creator/packages';

/**
 * Reads the creator catalog through the Better Auth session route. The API server delegates to
 * `api.packageRegistry.listByAuthUser`; the browser never receives the Convex API secret or actor
 * binding.
 */
export async function listCreatorPackageProducts(
  options: CreatorPackageProductListOptions = {}
): Promise<CreatorPackageProductListPage> {
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Creator package page limit must be an integer between 1 and 100');
  }

  return await apiClient.get<CreatorPackageProductListPage>(CREATOR_PACKAGES_PATH, {
    params: {
      configured: String(options.configured ?? true),
      limit: String(limit),
      ...(options.cursor ? { cursor: options.cursor } : {}),
    },
  });
}

function compareProviderProducts(
  left: CreatorPackageProductSummary,
  right: CreatorPackageProductSummary
): number {
  return (
    left.provider.localeCompare(right.provider) ||
    left.providerProductRef.localeCompare(right.providerProductRef) ||
    left._id.localeCompare(right._id)
  );
}

export function groupCreatorPackagePickerProducts(
  products: ReadonlyArray<CreatorPackageProductSummary>
): CreatorPackagePickerProduct[] {
  const comparableAliasBuckets = new Map<string, CreatorPackageProductSummary[]>();
  for (const product of products) {
    const comparableAliasId =
      resolveComparableYucpAliasIdsFromCatalogProduct(product)[0] ?? undefined;
    if (!comparableAliasId) continue;
    const bucket = comparableAliasBuckets.get(comparableAliasId) ?? [];
    bucket.push(product);
    comparableAliasBuckets.set(comparableAliasId, bucket);
  }

  const grouped = new Map<string, CreatorPackagePickerProduct>();
  const assignedProductIds = new Set<string>();
  for (const [comparableAliasId, bucket] of comparableAliasBuckets) {
    const providers = new Set(bucket.map((product) => product.provider));
    const packageIds = new Set(
      bucket
        .map((product) => product.packageId?.trim())
        .filter((packageId): packageId is string => Boolean(packageId))
    );
    if (bucket.length < 2 || providers.size !== bucket.length || packageIds.size > 1) {
      continue;
    }

    const packageId = packageIds.values().next().value as string | undefined;
    const identityKey = packageId ? `package:${packageId}` : `alias:${comparableAliasId}`;
    grouped.set(identityKey, { identityKey, products: [...bucket] });
    for (const product of bucket) {
      assignedProductIds.add(product._id);
    }
  }

  for (const product of products) {
    if (assignedProductIds.has(product._id)) continue;
    const identityKey = product.packageId
      ? `package:${product.packageId}`
      : `catalog:${product._id}`;
    const existing = grouped.get(identityKey);
    if (existing) {
      if (!existing.products.some((candidate) => candidate._id === product._id)) {
        existing.products.push(product);
      }
      continue;
    }
    grouped.set(identityKey, { identityKey, products: [product] });
  }

  return Array.from(grouped.values())
    .map((entry) => ({ ...entry, products: [...entry.products].sort(compareProviderProducts) }))
    .sort((left, right) => left.identityKey.localeCompare(right.identityKey));
}

export async function listCreatorPackagePickerProducts(): Promise<CreatorPackagePickerProduct[]> {
  const products: CreatorPackageProductSummary[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  do {
    const page = await listCreatorPackageProducts({ configured: false, cursor, limit: 100 });
    products.push(...page.data);
    if (!page.hasMore) {
      break;
    }
    if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
      throw new Error('Creator package picker pagination did not advance');
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);

  return groupCreatorPackagePickerProducts(products);
}

/**
 * Reads one creator-owned catalog product through the session endpoint backed by
 * `api.packageRegistry.getByIdForAuthUser`.
 */
export async function getCreatorPackageProduct(
  catalogProductId: string
): Promise<CreatorPackageProductSummary> {
  return await apiClient.get<CreatorPackageProductSummary>(
    `${CREATOR_PACKAGES_PATH}/${encodeURIComponent(catalogProductId)}`
  );
}
