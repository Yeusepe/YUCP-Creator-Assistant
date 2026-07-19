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

interface CreatorPackageProductListPage {
  data: CreatorPackageProductSummary[];
  hasMore: boolean;
  nextCursor: string | null;
}

const CREATOR_PACKAGES_PATH = '/api/creator/packages';

/**
 * Reads the creator catalog through the Better Auth session route. The API server delegates to
 * `api.packageRegistry.listByAuthUser`; the browser never receives the Convex API secret or actor
 * binding.
 */
export async function listCreatorPackageProducts(): Promise<CreatorPackageProductSummary[]> {
  const products: CreatorPackageProductSummary[] = [];
  let cursor: string | undefined;

  do {
    const page = await apiClient.get<CreatorPackageProductListPage>(CREATOR_PACKAGES_PATH, {
      params: {
        limit: '100',
        ...(cursor ? { cursor } : {}),
      },
    });
    products.push(...page.data);
    cursor = page.hasMore && page.nextCursor ? page.nextCursor : undefined;
  } while (cursor);

  return products;
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
