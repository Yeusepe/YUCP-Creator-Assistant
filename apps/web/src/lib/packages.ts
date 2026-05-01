import { sha256 } from '@noble/hashes/sha2.js';
import type { CdngineBackstageSourceReference } from '@yucp/shared/cdngineBackstageDelivery';
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

export interface BackstageDirectUploadTarget {
  expiresAt?: string;
  method: string;
  protocol: 'tus';
  url: string;
}

export interface BackstageReleaseUploadSessionResponse {
  completeUrl: string;
  packageId: string;
  uploadSessionId: string;
  uploadTarget: BackstageDirectUploadTarget;
}

export interface BackstageStorageUploadResponse {
  cdngineSource?: CdngineBackstageSourceReference;
  deliveryName?: string;
  sourceContentType?: string;
}

export interface BackstageReleaseUploadResult {
  cdngineSource: CdngineBackstageSourceReference;
  deliveryName?: string;
  sourceContentType?: string;
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
  cdngineSource: CdngineBackstageSourceReference;
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

export async function createBackstageReleaseUploadSession(input: {
  byteSize: number;
  deliveryName: string;
  packageId: string;
  sha256: string;
  sourceContentType: string;
}) {
  return await apiClient.post<BackstageReleaseUploadSessionResponse>(
    `/api/packages/${encodeURIComponent(input.packageId)}/backstage/upload-session`,
    {
      byteSize: input.byteSize,
      deliveryName: input.deliveryName,
      sha256: input.sha256,
      sourceContentType: input.sourceContentType,
    }
  );
}

export async function completeBackstageReleaseUploadSession(input: { completeUrl: string }) {
  const completeUrl =
    typeof window === 'undefined'
      ? input.completeUrl
      : (() => {
          const url = new URL(input.completeUrl, window.location.href);
          return url.origin === window.location.origin
            ? url.toString()
            : `${url.pathname}${url.search}`;
        })();
  const response = await fetch(completeUrl, {
    method: 'POST',
  });
  const payload = (await response
    .json()
    .catch(() => null)) as BackstageStorageUploadResponse | null;
  if (!response.ok) {
    throw new Error(
      `Failed to complete Backstage upload (${response.status} ${response.statusText})`
    );
  }
  if (!payload?.cdngineSource) {
    throw new Error('Backstage upload completion did not return CDNgine source coordinates');
  }
  return {
    cdngineSource: payload.cdngineSource,
    deliveryName: payload.deliveryName,
    sourceContentType: payload.sourceContentType,
  };
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

async function uploadBackstageFileToTarget(input: {
  file: File;
  onProgress?: (progress: BackstageReleaseUploadProgress) => void;
  uploadTarget: BackstageDirectUploadTarget;
}) {
  if (input.uploadTarget.protocol !== 'tus') {
    throw new Error(`Unsupported Backstage upload protocol "${input.uploadTarget.protocol}".`);
  }
  const xhrConstructor = globalThis.XMLHttpRequest;
  if (xhrConstructor) {
    await new Promise<void>((resolve, reject) => {
      const request = new xhrConstructor();
      request.open(input.uploadTarget.method, input.uploadTarget.url);
      request.setRequestHeader('Content-Type', 'application/offset+octet-stream');
      request.setRequestHeader('Tus-Resumable', '1.0.0');
      request.setRequestHeader('Upload-Offset', '0');
      request.upload.onprogress = (event) => {
        if (!event.lengthComputable) {
          return;
        }
        input.onProgress?.({
          progress: Math.min(99, Math.round((event.loaded / event.total) * 100)),
          stage: 'uploading',
        });
      };
      request.onload = () => {
        if (request.status >= 200 && request.status < 300) {
          input.onProgress?.({ progress: 100, stage: 'uploading' });
          resolve();
          return;
        }
        reject(new Error(`CDNgine upload target rejected the file with status ${request.status}.`));
      };
      request.onerror = () => reject(new Error('CDNgine upload target request failed.'));
      request.send(input.file);
    });
    return;
  }

  input.onProgress?.({ progress: 0, stage: 'uploading' });
  const response = await fetch(input.uploadTarget.url, {
    method: input.uploadTarget.method,
    headers: {
      'Content-Type': 'application/offset+octet-stream',
      'Tus-Resumable': '1.0.0',
      'Upload-Offset': '0',
    },
    body: input.file,
  });
  if (!response.ok) {
    throw new Error(
      `CDNgine upload target rejected the file (${response.status} ${response.statusText})`
    );
  }
  input.onProgress?.({ progress: 100, stage: 'uploading' });
}

export async function uploadBackstageReleaseFileDirect(input: {
  file: File;
  onProgress?: (progress: BackstageReleaseUploadProgress) => void;
  packageId: string;
}): Promise<BackstageReleaseUploadResult> {
  const sourceContentType = input.file.type || 'application/octet-stream';
  const digest = await sha256File(input.file, input.onProgress);
  const session = await createBackstageReleaseUploadSession({
    byteSize: input.file.size,
    deliveryName: input.file.name,
    packageId: input.packageId,
    sha256: digest,
    sourceContentType,
  });
  await uploadBackstageFileToTarget({
    file: input.file,
    onProgress: input.onProgress,
    uploadTarget: session.uploadTarget,
  });
  const result = await completeBackstageReleaseUploadSession({ completeUrl: session.completeUrl });
  input.onProgress?.({ progress: 100, stage: 'complete' });
  return result;
}

export async function uploadBackstageReleaseFile(input: {
  uploadUrl: string;
  file: File;
}): Promise<BackstageReleaseUploadResult> {
  const response = await fetch(input.uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': input.file.type || 'application/octet-stream',
      'X-YUCP-File-Name': encodeURIComponent(input.file.name),
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

  if (!payload?.cdngineSource) {
    throw new Error('Backstage upload did not return CDNgine source coordinates');
  }

  return {
    cdngineSource: payload.cdngineSource,
    deliveryName: payload.deliveryName,
    sourceContentType: payload.sourceContentType,
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
