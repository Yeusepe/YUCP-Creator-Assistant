import {
  catalogTierPackageEditionId,
  STANDARD_PACKAGE_EDITION_ID,
} from '@yucp/shared/packageEdition';
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

export interface CreatorPackageVersionSummary {
  createdAt: string;
  editionId: string;
  packageId: string;
  state: Exclude<CreatorPackageVersionStatus['state'], 'deleted'>;
  updatedAt: string;
  version: string;
  versionId: string;
}

export interface CreatorPackageVersionListPage {
  data: CreatorPackageVersionSummary[];
  hasMore: boolean;
  nextCursor: string | null;
}

export type CreatorPackageVersionStatus = {
  editionId: string;
  errorCategory: 'processing' | null;
  errorCode: 'PACKAGE_VERSION_PROCESSING_FAILED' | null;
  estimatedStartAt: string | null;
  packageId: string;
  queuePosition: number | null;
  state:
    | 'queued'
    | 'uploading'
    | 'preparing'
    | 'publishing'
    | 'recovering'
    | 'ready'
    | 'failed'
    | 'deleted';
  updatedAt: string;
  version: string;
  versionId: string;
};

export interface CreatorPackageEditionSummary {
  catalogProductIds: string[];
  catalogTierIds: string[];
  createdAt: number;
  displayName: string;
  editionId: string;
  priority: number;
  status: 'active' | 'archived';
  updatedAt: number;
}

export interface CreatorPackageEditionOption {
  catalogTierId?: string;
  displayName: string;
  editionId: string;
  provider?: string;
  source: 'catalog-tier' | 'managed' | 'standard';
  status: 'active' | 'archived';
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
  packageName?: string;
  publicCreatorSlug?: string;
  publicSlug?: string;
  packageAssociationUpdatedAt?: number;
  packageEditions?: CreatorPackageEditionSummary[];
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

export function getCreatorPackageEditionOptions(
  product: CreatorPackageProductSummary
): CreatorPackageEditionOption[] {
  const packageEditions = product.packageEditions ?? [];
  const mappedCatalogTierIds = new Set(
    packageEditions.flatMap((edition) => edition.catalogTierIds)
  );
  const managedEditions: CreatorPackageEditionOption[] = packageEditions
    .filter(
      (edition) => edition.status === 'active' && edition.editionId !== STANDARD_PACKAGE_EDITION_ID
    )
    .map((edition) => ({
      displayName: edition.displayName,
      editionId: edition.editionId,
      source: 'managed',
      status: edition.status,
    }));
  const catalogTierEditions: CreatorPackageEditionOption[] = product.catalogTiers
    .filter(
      (tier) =>
        tier.status === 'active' &&
        Boolean(tier.catalogProductId) &&
        !mappedCatalogTierIds.has(tier._id)
    )
    .map((tier) => ({
      catalogTierId: tier._id,
      displayName: tier.displayName,
      editionId: catalogTierPackageEditionId(tier._id),
      provider: tier.provider,
      source: 'catalog-tier',
      status: 'active',
    }));

  return [
    {
      displayName: 'Standard',
      editionId: STANDARD_PACKAGE_EDITION_ID,
      source: 'standard',
      status: 'active',
    },
    ...[...managedEditions, ...catalogTierEditions].sort(
      (left, right) =>
        left.displayName.localeCompare(right.displayName) ||
        left.editionId.localeCompare(right.editionId)
    ),
  ];
}

export type CreatorPackageVccLink =
  | {
      bootstrapDownloadUrl: string;
      status: 'inactive';
      unityPackageDownloadUrl: string;
    }
  | {
      bootstrapDownloadUrl: string;
      createdAt: number;
      status: 'active';
      unityPackageDownloadUrl: string;
    };

export interface CreatorPackagePresentation {
  packageName: string;
  published: boolean;
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
  const grouped = new Map<string, CreatorPackagePickerProduct>();
  for (const product of [...products].sort(compareProviderProducts)) {
    const identityKey = product.packageId
      ? `package:${product.packageId}`
      : `catalog:${product._id}`;
    const existing = grouped.get(identityKey);
    if (existing) {
      existing.products.push(product);
    } else {
      grouped.set(identityKey, {
        identityKey,
        products: [product],
      });
    }
  }
  return [...grouped.values()];
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

export async function updateCreatorPackagePublicLink(
  packageId: string,
  publicSlug: string
): Promise<{ packageId: string; publicSlug: string }> {
  return await apiClient.put(
    `${CREATOR_PACKAGES_PATH}/by-package/${encodeURIComponent(packageId)}/public-link`,
    { publicSlug }
  );
}

function creatorPackageEditionVersionsPath(packageId: string, editionId: string): string {
  return `${CREATOR_PACKAGES_PATH}/by-package/${encodeURIComponent(
    packageId
  )}/editions/${encodeURIComponent(editionId)}/versions`;
}

export async function listCreatorPackageVersions(
  packageId: string,
  editionId: string,
  options: { cursor?: string; limit?: number } = {}
): Promise<CreatorPackageVersionListPage> {
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Creator release page limit must be an integer between 1 and 100');
  }
  return await apiClient.get<CreatorPackageVersionListPage>(
    creatorPackageEditionVersionsPath(packageId, editionId),
    {
      params: {
        limit: String(limit),
        ...(options.cursor ? { cursor: options.cursor } : {}),
      },
    }
  );
}

export async function deleteCreatorPackageVersion(
  packageId: string,
  editionId: string,
  versionId: string
): Promise<{ deletedAt: string; state: 'DELETED'; versionId: string }> {
  return await apiClient.delete(
    `${creatorPackageEditionVersionsPath(packageId, editionId)}/${encodeURIComponent(versionId)}`
  );
}

export async function getCreatorPackageVersionStatus(
  packageId: string,
  editionId: string,
  versionId: string
): Promise<CreatorPackageVersionStatus> {
  return await apiClient.get<CreatorPackageVersionStatus>(
    `${creatorPackageEditionVersionsPath(packageId, editionId)}/${encodeURIComponent(
      versionId
    )}/status`
  );
}

export async function saveCreatorPackageEdition(
  catalogProductId: string,
  input: {
    catalogProductIds: string[];
    catalogTierIds: string[];
    displayName: string;
    editionId: string;
    priority: number;
  }
): Promise<{ editionId: string; saved: boolean }> {
  return await apiClient.put(
    `${CREATOR_PACKAGES_PATH}/${encodeURIComponent(
      catalogProductId
    )}/editions/${encodeURIComponent(input.editionId)}`,
    {
      catalogProductIds: input.catalogProductIds,
      catalogTierIds: input.catalogTierIds,
      displayName: input.displayName,
      priority: input.priority,
    }
  );
}

export async function archiveCreatorPackageEdition(
  catalogProductId: string,
  editionId: string
): Promise<{ archived: boolean; editionId: string }> {
  return await apiClient.delete(
    `${CREATOR_PACKAGES_PATH}/${encodeURIComponent(
      catalogProductId
    )}/editions/${encodeURIComponent(editionId)}`
  );
}

export async function bindCreatorPackageStorefront(
  catalogProductId: string,
  targetCatalogProductId: string
): Promise<{
  bound: boolean;
  catalogProductId: string;
  packageId: string;
}> {
  return await apiClient.put(
    `${CREATOR_PACKAGES_PATH}/${encodeURIComponent(
      catalogProductId
    )}/storefronts/${encodeURIComponent(targetCatalogProductId)}`,
    {}
  );
}

export async function unbindCreatorPackageStorefront(
  catalogProductId: string,
  targetCatalogProductId: string
): Promise<{ unbound: boolean }> {
  return await apiClient.delete(
    `${CREATOR_PACKAGES_PATH}/${encodeURIComponent(
      catalogProductId
    )}/storefronts/${encodeURIComponent(targetCatalogProductId)}`
  );
}

export async function getCreatorPackageVccLink(packageId: string): Promise<CreatorPackageVccLink> {
  return await apiClient.get(
    `${CREATOR_PACKAGES_PATH}/by-package/${encodeURIComponent(packageId)}/vcc-link`
  );
}

export async function createCreatorPackageVccLink(
  packageId: string
): Promise<CreatorPackageVccLink> {
  return await apiClient.post(
    `${CREATOR_PACKAGES_PATH}/by-package/${encodeURIComponent(packageId)}/vcc-link`
  );
}

export async function revokeCreatorPackageVccLink(
  packageId: string
): Promise<{ revoked: boolean }> {
  return await apiClient.delete(
    `${CREATOR_PACKAGES_PATH}/by-package/${encodeURIComponent(packageId)}/vcc-link`
  );
}

export async function updateCreatorPackagePresentation(
  packageId: string,
  packageName: string
): Promise<CreatorPackagePresentation> {
  return await apiClient.put(
    `${CREATOR_PACKAGES_PATH}/by-package/${encodeURIComponent(packageId)}/presentation`,
    { packageName }
  );
}
