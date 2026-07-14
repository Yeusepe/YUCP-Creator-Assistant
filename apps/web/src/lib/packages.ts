import { sha256 } from '@noble/hashes/sha2.js';
import type {
  BackstagePackageMediaKind,
  BackstagePackageMediaReference,
} from '@yucp/shared/backstagePackageMedia';
import { assertSecureLoreUrl } from '@yucp/shared/loreBackstageClient';
import { apiClient } from '@/api/client';
import { startHyperdxBrowserSpan } from '@/lib/hyperdx';

const BACKSTAGE_INGEST_POLL_INTERVAL_MS = 1000;
const BACKSTAGE_INGEST_POLL_REQUEST_TIMEOUT_MS = 15_000;
const BACKSTAGE_INGEST_POLL_TIMEOUT_MS = 20 * 60 * 1000;
const BACKSTAGE_TUS_CHUNK_SIZE = 64 * 1024 * 1024;

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
  ingestResult: string;
  version: string;
  deliveryName: string;
  sourceContentType: string;
}

export interface BackstageReleaseMaterializeMetadata {
  displayName?: string;
  metadata?: Record<string, unknown>;
}

export interface BackstageReleaseMediaUploadInput {
  bytes: Uint8Array;
  contentType: string;
  deliveryName: string;
  kind: BackstagePackageMediaKind;
  packageId: string;
  sourcePath?: string;
}

export interface BackstageReleaseUploadProgress {
  loaded: number;
  total: number;
}

export interface BackstagePackageDependencyVersion {
  packageId: string;
  version: string;
}

export interface PublishBackstageReleaseInput {
  catalogProductId?: string;
  catalogProductIds?: string[];
  accessSelectors?: BackstageAccessSelector[];
  ingestResult: string;
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

function abortError(signal: AbortSignal): DOMException {
  const message = signal.reason instanceof Error ? signal.reason.message : 'Upload aborted';
  return new DOMException(message, 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

async function sha256File(file: File, signal?: AbortSignal) {
  throwIfAborted(signal);
  const hasher = sha256.create();
  const chunkSize = 16 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    throwIfAborted(signal);
    const chunk = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
    throwIfAborted(signal);
    hasher.update(chunk);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throwIfAborted(signal);
  return bytesToHex(hasher.digest());
}

interface BackstageUploadAuthorizationResponse {
  maxByteSize: number;
  tusEndpoint: string;
  uploadMetadataKey: string;
  uploadToken: string;
}

type BackstageIngestJobResponse =
  | { state: 'processing' }
  | { state: 'completed'; result: string }
  | { state: 'failed'; reason: string };

function waitForBackstageIngestPoll(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolve();
    }, BACKSTAGE_INGEST_POLL_INTERVAL_MS);

    function handleAbort() {
      clearTimeout(timeout);
      reject(signal ? abortError(signal) : new DOMException('Upload aborted', 'AbortError'));
    }

    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

async function pollBackstageIngestJob(input: {
  jobUrl: string;
  signal?: AbortSignal;
  uploadToken: string;
}): Promise<string> {
  const deadline = Date.now() + BACKSTAGE_INGEST_POLL_TIMEOUT_MS;

  for (;;) {
    throwIfAborted(input.signal);
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the Backstage ingest job to complete');
    }

    let response: Response;
    try {
      response = await fetch(input.jobUrl, {
        headers: { Authorization: `Bearer ${input.uploadToken}` },
        redirect: 'error',
        signal: AbortSignal.any(
          [input.signal, AbortSignal.timeout(BACKSTAGE_INGEST_POLL_REQUEST_TIMEOUT_MS)].filter(
            (signal): signal is AbortSignal => signal !== undefined
          )
        ),
      });
    } catch (error) {
      if (input.signal?.aborted) {
        throw error;
      }
      await waitForBackstageIngestPoll(input.signal);
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `Backstage ingest job polling failed (${response.status} ${response.statusText})`
      );
    }

    const job = (await response.json()) as BackstageIngestJobResponse;
    if (job.state === 'completed') {
      if (typeof job.result !== 'string' || !job.result.trim()) {
        throw new Error('Completed Backstage ingest job did not return a signed result');
      }
      return job.result;
    }
    if (job.state === 'failed') {
      throw new Error(`Backstage ingest job failed: ${job.reason}`);
    }

    await waitForBackstageIngestPoll(input.signal);
  }
}

export async function uploadBackstageReleaseSource(input: {
  deliveryName?: string;
  file: File;
  onProcessing?: () => void;
  onProgress?: (progress: BackstageReleaseUploadProgress) => void;
  packageId: string;
  signal?: AbortSignal;
  sourceContentType?: string;
  version: string;
}): Promise<BackstageReleaseUploadResult> {
  const deliveryName = input.deliveryName ?? input.file.name;
  const sourceContentType =
    input.sourceContentType || input.file.type || 'application/octet-stream';
  throwIfAborted(input.signal);
  const sha256 = await sha256File(input.file, input.signal);
  throwIfAborted(input.signal);
  const authorization = await apiClient.post<BackstageUploadAuthorizationResponse>(
    `/api/packages/${encodeURIComponent(input.packageId)}/backstage/upload-authorization`,
    {
      version: input.version,
      sha256,
      deliveryName,
      sourceContentType,
      byteSize: input.file.size,
    },
    { signal: input.signal }
  );
  throwIfAborted(input.signal);
  const tus = await import('tus-js-client');
  throwIfAborted(input.signal);
  const uploadSpan = startHyperdxBrowserSpan('backstage.ingest.upload', {
    packageId: input.packageId,
    version: input.version,
    byteSize: input.file.size,
  });

  const ingestResult = await new Promise<string>((resolve, reject) => {
    let settled = false;

    const cleanup = () => input.signal?.removeEventListener('abort', handleAbort);
    const resolveOnce = (value: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      uploadSpan.end({ status: 'success' });
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      uploadSpan.fail(error);
      reject(error);
    };
    const upload = new tus.Upload(input.file, {
      endpoint: authorization.tusEndpoint,
      metadata: {
        [authorization.uploadMetadataKey]: authorization.uploadToken,
      },
      chunkSize: BACKSTAGE_TUS_CHUNK_SIZE,
      retryDelays: [0, 1000, 3000, 5000],
      removeFingerprintOnSuccess: true,
      onProgress: (bytesSent, bytesTotal) => {
        input.onProgress?.({ loaded: bytesSent, total: bytesTotal });
      },
      onSuccess: () => {
        const uploadUrl = upload.url;
        if (!uploadUrl) {
          rejectOnce(new Error('Ingest service did not return the completed upload URL'));
          return;
        }
        if (!uploadUrl.includes('/files/')) {
          rejectOnce(
            new Error('Ingest service upload URL does not contain the expected /files/ path')
          );
          return;
        }
        const jobUrl = uploadUrl.replace('/files/', '/jobs/');
        try {
          assertSecureLoreUrl(jobUrl, 'jobUrl');
        } catch (error) {
          rejectOnce(error);
          return;
        }
        let authorizedOrigin: string;
        let jobOrigin: string;
        try {
          authorizedOrigin = new URL(authorization.tusEndpoint).origin;
          jobOrigin = new URL(jobUrl).origin;
        } catch {
          rejectOnce(new Error('Backstage ingest returned an invalid upload or authorization URL'));
          return;
        }
        if (jobOrigin !== authorizedOrigin) {
          rejectOnce(
            new Error(
              'Backstage ingest completed upload URL does not match the authorized TUS endpoint origin'
            )
          );
          return;
        }
        input.onProcessing?.();
        void pollBackstageIngestJob({
          jobUrl,
          signal: input.signal,
          uploadToken: authorization.uploadToken,
        }).then(resolveOnce, rejectOnce);
      },
      onError: rejectOnce,
    });

    function handleAbort() {
      const abortError =
        input.signal?.reason instanceof Error
          ? input.signal.reason
          : new DOMException('Upload aborted', 'AbortError');
      void upload.abort().then(
        () => rejectOnce(abortError),
        (error) => rejectOnce(error)
      );
    }

    input.signal?.addEventListener('abort', handleAbort, { once: true });
    if (input.signal?.aborted) {
      handleAbort();
      return;
    }
    upload.start();
  });

  return {
    ingestResult,
    version: input.version,
    deliveryName,
    sourceContentType,
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
