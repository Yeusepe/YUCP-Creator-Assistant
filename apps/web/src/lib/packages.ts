import { apiClient } from '@/api/client';

export interface CreatorPackageSummary {
  packageId: string;
  packageName?: string;
  registeredAt: number;
  updatedAt: number;
  status: 'active' | 'archived';
  archivedAt?: number;
  canDelete: boolean;
  deleteBlockedReason?: string;
  canArchive: boolean;
  canRestore: boolean;
}

export interface CreatorPackageListResponse {
  packages: CreatorPackageSummary[];
}

export interface CreatorBackstagePackageReleaseSummary {
  deliveryPackageReleaseId: string;
  version: string;
  channel: string;
  releaseStatus: 'draft' | 'published' | 'revoked' | 'superseded';
  repositoryVisibility: 'hidden' | 'listed';
  artifactKey?: string;
  contentType?: string;
  createdAt: number;
  deliveryName?: string;
  metadata?: unknown;
  publishedAt?: number;
  unityVersion?: string;
  updatedAt: number;
  zipSha256?: string;
}

export interface CreatorBackstageProductPackageSummary {
  packageId: string;
  packageName?: string;
  displayName?: string;
  status: 'active' | 'archived';
  repositoryVisibility: 'hidden' | 'listed';
  defaultChannel?: string;
  latestPublishedVersion?: string;
  latestRelease: CreatorBackstagePackageReleaseSummary | null;
  releases: CreatorBackstagePackageReleaseSummary[];
}

export type BackstageAccessSelector =
  | {
      kind: 'catalogProduct';
      catalogProductId: string;
    }
  | {
      kind: 'catalogTier';
      catalogTierId: string;
    };

export interface CreatorBackstageCatalogTierSummary {
  catalogTierId: string;
  catalogProductId?: string;
  provider: string;
  providerTierRef: string;
  displayName: string;
  description?: string;
  amountCents?: number;
  currency?: string;
  status: 'active' | 'archived';
  metadata?: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface CreatorBackstageProductSummary {
  aliases: string[];
  catalogTiers?: CreatorBackstageCatalogTierSummary[];
  backstagePackages: CreatorBackstageProductPackageSummary[];
  canonicalSlug?: string;
  catalogProductId: string;
  displayName?: string;
  thumbnailUrl?: string;
  productId: string;
  provider: string;
  providerProductRef: string;
  status: 'active' | 'archived';
  supportsAutoDiscovery: boolean;
  updatedAt: number;
  canArchive: boolean;
  canRestore: boolean;
  canDelete: boolean;
  deleteBlockedReason?: string;
}

export interface CreatorBackstageProductListResponse {
  products: CreatorBackstageProductSummary[];
}

export interface BackstageRepoAccessResponse {
  creatorName?: string;
  creatorRepoRef: string;
  repositoryUrl: string;
  repositoryName: string;
  addRepoUrl: string;
  expiresAt: number;
}

export interface BackstageReleaseUploadUrlResponse {
  packageId: string;
  uploadUrl: string;
}

export interface BackstageStorageUploadResponse {
  storageId?: string;
}

export interface BackstageReleaseUploadResult {
  storageId: string;
}

export interface BackstagePackageDependencyVersion {
  packageId: string;
  version: string;
}

export interface PublishBackstageReleaseInput {
  catalogProductId?: string;
  catalogProductIds?: string[];
  accessSelectors?: BackstageAccessSelector[];
  storageId: string;
  version: string;
  channel?: string;
  packageName?: string;
  displayName?: string;
  description?: string;
  repositoryVisibility?: 'hidden' | 'listed';
  defaultChannel?: string;
  unityVersion?: string;
  dependencyVersions?: BackstagePackageDependencyVersion[];
  metadata?: unknown;
  deliveryName?: string;
  sourceContentType?: string;
  releaseStatus?: 'draft' | 'published' | 'revoked' | 'superseded';
}

export interface PublishBackstageReleaseResponse {
  deliveryPackageReleaseId: string;
  artifactId?: string;
  artifactKey?: string;
  zipSha256: string;
  version: string;
  channel: string;
}

export async function listCreatorPackages(input?: { includeArchived?: boolean }) {
  const search = input?.includeArchived ? '?includeArchived=true' : '';
  return await apiClient.get<CreatorPackageListResponse>(`/api/packages${search}`);
}

export async function listCreatorBackstageProducts() {
  return await apiClient.get<CreatorBackstageProductListResponse>(
    '/api/packages/backstage/products'
  );
}

export async function requestBackstageRepoAccess() {
  return await apiClient.get<BackstageRepoAccessResponse>('/api/packages/backstage/repo-access');
}

export async function renameCreatorPackage(input: { packageId: string; packageName: string }) {
  return await apiClient.patch<{
    updated: true;
    packageId: string;
    packageName: string;
  }>(`/api/packages/${encodeURIComponent(input.packageId)}`, {
    packageName: input.packageName,
  });
}

export async function deleteCreatorPackage(input: { packageId: string }) {
  return await apiClient.delete<{
    deleted: true;
    packageId: string;
  }>(`/api/packages/${encodeURIComponent(input.packageId)}`);
}

export async function archiveCreatorPackage(input: { packageId: string }) {
  return await apiClient.post<{
    archived: true;
    packageId: string;
  }>(`/api/packages/${encodeURIComponent(input.packageId)}/archive`);
}

export async function restoreCreatorPackage(input: { packageId: string }) {
  return await apiClient.post<{
    restored: true;
    packageId: string;
  }>(`/api/packages/${encodeURIComponent(input.packageId)}/restore`);
}

export async function archiveCreatorBackstageProduct(input: { catalogProductId: string }) {
  return await apiClient.post<{
    archived: true;
    catalogProductId: string;
  }>(`/api/packages/backstage/products/${encodeURIComponent(input.catalogProductId)}/archive`);
}

export async function restoreCreatorBackstageProduct(input: { catalogProductId: string }) {
  return await apiClient.post<{
    restored: true;
    catalogProductId: string;
  }>(`/api/packages/backstage/products/${encodeURIComponent(input.catalogProductId)}/restore`);
}

export async function deleteCreatorBackstageProduct(input: { catalogProductId: string }) {
  return await apiClient.delete<{
    deleted: true;
    catalogProductId: string;
  }>(`/api/packages/backstage/products/${encodeURIComponent(input.catalogProductId)}`);
}

export async function archiveCreatorBackstageRelease(input: {
  packageId: string;
  deliveryPackageReleaseId: string;
}) {
  return await apiClient.post<{
    archived: true;
    deliveryPackageReleaseId: string;
  }>(
    `/api/packages/${encodeURIComponent(input.packageId)}/backstage/releases/${encodeURIComponent(input.deliveryPackageReleaseId)}/archive`
  );
}

export async function deleteCreatorBackstageRelease(input: {
  packageId: string;
  deliveryPackageReleaseId: string;
}) {
  return await apiClient.delete<{
    deleted: true;
    deliveryPackageReleaseId: string;
  }>(
    `/api/packages/${encodeURIComponent(input.packageId)}/backstage/releases/${encodeURIComponent(input.deliveryPackageReleaseId)}`
  );
}

export async function createBackstageReleaseUploadUrl(input: { packageId: string }) {
  return await apiClient.post<BackstageReleaseUploadUrlResponse>(
    `/api/packages/${encodeURIComponent(input.packageId)}/backstage/upload-url`
  );
}

export async function uploadBackstageReleaseFile(input: {
  uploadUrl: string;
  file: File;
}): Promise<BackstageReleaseUploadResult> {
  const response = await fetch(input.uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': input.file.type || 'application/octet-stream',
    },
    body: input.file,
  });

  const payload = (await response
    .json()
    .catch(() => null)) as BackstageStorageUploadResponse | null;
  if (!response.ok) {
    throw new Error(
      `Failed to upload Backstage release (${response.status} ${response.statusText})`
    );
  }

  if (!payload?.storageId) {
    throw new Error('Backstage upload did not return storageId');
  }

  return {
    storageId: payload.storageId,
  };
}

export async function publishBackstageRelease(input: {
  packageId: string;
  body: PublishBackstageReleaseInput;
}) {
  return await apiClient.post<PublishBackstageReleaseResponse>(
    `/api/packages/${encodeURIComponent(input.packageId)}/backstage/releases`,
    input.body
  );
}
