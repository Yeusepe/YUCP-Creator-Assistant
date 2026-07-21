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

export interface CreatorPackageProductSummary {
  _id: string;
  aliases?: string[];
  canonicalSlug?: string;
  catalogTiers: CreatorCatalogTierSummary[];
  displayName?: string;
  thumbnailUrl?: string;
  productId: string;
  provider: string;
  providerProductRef: string;
  status: 'active' | 'archived';
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
  cursor?: string;
  limit?: number;
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
      limit: String(limit),
      ...(options.cursor ? { cursor: options.cursor } : {}),
    },
  });
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
