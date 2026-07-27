import { Upload } from 'tus-js-client';
import { apiClient } from '@/api/client';
import { startHyperdxBrowserSpan } from '@/lib/hyperdx';

const UPLOAD_CHUNK_BYTES = 16 * 1024 * 1024;

export interface UploadAuthorization {
  versionId: string;
  exp: string;
  sig: string;
  tusEndpoint: string;
  headers: Record<string, string>;
  catalogProductId?: string;
  protectionPolicyId: 'supported-visual-assets-v2';
}

function getTusResponseStatus(error: Error): number | undefined {
  const response = (
    error as Error & {
      originalResponse?: { getStatus?: () => unknown } | null;
    }
  ).originalResponse;
  if (typeof response?.getStatus !== 'function') {
    return undefined;
  }
  try {
    const status = response.getStatus();
    return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeUploadError(error: Error): Error {
  const status = getTusResponseStatus(error);
  if (status === 409) {
    return new Error(
      'This package version already exists or is still being prepared. Wait for it to finish, or use a new version.'
    );
  }
  if (status === 413) {
    return new Error('This package is larger than the current upload limit.');
  }
  if (status === 429 || status === 503) {
    return new Error(
      'Upload capacity is busy. Your package draft is safe. Keep this page open and try again shortly.'
    );
  }
  if (status === 401 || status === 403) {
    return new Error('Upload authorization expired. Start the upload again from this saved draft.');
  }
  if (status !== undefined && status >= 500) {
    return new Error(
      'The upload service could not accept this package. Your draft is safe. Try again shortly.'
    );
  }
  return new Error(
    'The package upload was interrupted. Your draft is safe. Check your connection and try again.'
  );
}

export async function authorizeUpload(
  packageId: string,
  version: string,
  editionId: string,
  catalogProductIds?: readonly string[],
  catalogTierId?: string
): Promise<UploadAuthorization> {
  return await apiClient.post<UploadAuthorization>('/api/creator/uploads/authorize', {
    packageId,
    editionId,
    version,
    ...(catalogProductIds?.length ? { catalogProductIds: [...catalogProductIds] } : {}),
    ...(catalogTierId ? { catalogTierId } : {}),
  });
}

export async function uploadPackageFile(input: {
  file: File;
  editionId?: string;
  packageId: string;
  version: string;
  catalogProductIds?: readonly string[];
  catalogTierId?: string;
  onAuthorized?: (authorization: UploadAuthorization) => void;
  onProgress?: (percent: number) => void;
  onError?: (error: Error) => void;
  onSuccess?: () => void;
}): Promise<Upload> {
  const authorization = await authorizeUpload(
    input.packageId,
    input.version,
    input.editionId ?? 'standard',
    input.catalogProductIds,
    input.catalogTierId
  );
  input.onAuthorized?.(authorization);
  const catalogProductId = authorization.catalogProductId;
  const span = startHyperdxBrowserSpan('creator.upload', {
    byteSize: input.file.size,
  });
  const upload = new Upload(input.file, {
    endpoint: authorization.tusEndpoint,
    fingerprint: async (file) =>
      `yucp-${authorization.versionId}-${file.name}-${file.size}-${file.lastModified}`,
    headers: authorization.headers,
    chunkSize: UPLOAD_CHUNK_BYTES,
    retryDelays: [0, 1_000, 3_000, 5_000, 10_000],
    removeFingerprintOnSuccess: true,
    metadata: {
      filename: input.file.name,
      filetype: input.file.type || 'application/octet-stream',
      editionId: input.editionId ?? 'standard',
      packageId: input.packageId,
      protectionPolicyId: authorization.protectionPolicyId,
      version: input.version,
      ...(catalogProductId ? { catalogProductId } : {}),
    },
    onProgress(bytesUploaded, bytesTotal) {
      input.onProgress?.(bytesTotal === 0 ? 0 : (bytesUploaded / bytesTotal) * 100);
    },
    onError(error) {
      span.fail(error);
      input.onError?.(normalizeUploadError(error));
    },
    onSuccess() {
      span.end({ byteSize: input.file.size });
      input.onSuccess?.();
    },
  });

  const previousUploads = await upload.findPreviousUploads();
  const previousUpload = previousUploads[0];
  if (previousUpload) {
    upload.resumeFromPreviousUpload(previousUpload);
  }
  upload.start();
  return upload;
}
