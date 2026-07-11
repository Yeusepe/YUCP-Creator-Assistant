import { sha256 } from '@noble/hashes/sha2.js';
import type {
  BackstagePackageMediaKind,
  BackstagePackageMediaReference,
} from '@yucp/shared/backstagePackageMedia';
import type { LoreBackstageArtifactReference } from '@yucp/shared/loreBackstageDelivery';
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

export interface BackstageReleaseUploadResult {
  loreSource: LoreBackstageArtifactReference;
  deliveryName?: string;
  sourceContentType?: string;
}

export interface BackstageReleaseMediaUploadInput {
  bytes: Uint8Array;
  contentType: string;
  deliveryName: string;
  kind: BackstagePackageMediaKind;
  packageId: string;
  sourcePath?: string;
}

export type BackstageReleaseUploadProgress =
  | {
      progress: number;
      stage: 'hashing';
    }
  | {
      progress: number;
      stage: 'uploading';
    }
  | {
      progress: 100;
      stage: 'complete';
    };

export interface BackstagePackageDependencyVersion {
  packageId: string;
  version: string;
}

export interface PublishBackstageReleaseInput {
  catalogProductId?: string;
  catalogProductIds?: string[];
  accessSelectors?: BackstageAccessSelector[];
  loreSource: LoreBackstageArtifactReference;
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

export async function listCreatorBackstageProducts(input?: { liveSync?: boolean }) {
  const search = input?.liveSync ? '?liveSync=true' : '';
  return await apiClient.get<CreatorBackstageProductListResponse>(
    `/api/packages/backstage/products${search}`
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

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256File(
  file: File,
  onProgress?: (progress: BackstageReleaseUploadProgress) => void
) {
  const hasher = sha256.create();
  const chunkSize = 16 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const chunk = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
    hasher.update(chunk);
    onProgress?.({
      progress: Math.min(99, Math.round(((offset + chunk.byteLength) / file.size) * 100)),
      stage: 'hashing',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return bytesToHex(hasher.digest());
}

export async function uploadBackstageReleaseSource(input: {
  deliveryName?: string;
  file: File;
  onProgress?: (progress: BackstageReleaseUploadProgress) => void;
  packageId: string;
  sourceContentType?: string;
}): Promise<BackstageReleaseUploadResult> {
  const deliveryName = input.deliveryName || input.file.name;
  const sourceContentType =
    input.sourceContentType || input.file.type || 'application/octet-stream';
  const sha256 = await sha256File(input.file, input.onProgress);
  input.onProgress?.({ progress: 0, stage: 'uploading' });
  const payload = await apiClient.upload<{
    loreSource?: LoreBackstageArtifactReference;
    deliveryName?: string;
    sourceContentType?: string;
  }>(`/api/packages/${encodeURIComponent(input.packageId)}/backstage/upload`, input.file, {
    headers: {
      'Content-Type': sourceContentType,
    },
    params: {
      sha256,
      deliveryName,
      sourceContentType,
    },
    onProgress: ({ loaded, total }) => {
      input.onProgress?.({
        progress: Math.min(99, Math.round((loaded / total) * 100)),
        stage: 'uploading',
      });
    },
  });
  if (!payload?.loreSource) {
    throw new Error('Backstage source upload did not return Lore source coordinates');
  }
  input.onProgress?.({ progress: 100, stage: 'uploading' });
  input.onProgress?.({ progress: 100, stage: 'complete' });
  return {
    loreSource: payload.loreSource,
    deliveryName: payload.deliveryName,
    sourceContentType: payload.sourceContentType,
  };
}

export async function uploadBackstageReleaseMedia(
  input: BackstageReleaseMediaUploadInput
): Promise<BackstagePackageMediaReference> {
  const requestBody = new ArrayBuffer(input.bytes.byteLength);
  new Uint8Array(requestBody).set(input.bytes);
  const response = await fetch(
    `/api/packages/${encodeURIComponent(input.packageId)}/backstage/media?kind=${encodeURIComponent(input.kind)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': input.contentType,
        'X-YUCP-File-Name': encodeURIComponent(input.deliveryName),
        'X-YUCP-Media-Kind': input.kind,
        ...(input.sourcePath ? { 'X-YUCP-Source-Path': input.sourcePath } : {}),
      },
      body: requestBody,
    }
  );

  const payload = (await response.json().catch(() => null)) as
    | BackstagePackageMediaReference
    | { error?: string }
    | null;
  if (!response.ok) {
    throw new Error(
      payload && 'error' in payload && payload.error
        ? payload.error
        : `Failed to upload Backstage package media (${response.status} ${response.statusText})`
    );
  }

  if (!payload || !('kind' in payload)) {
    throw new Error('Backstage media upload did not return a media reference');
  }

  return payload;
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
