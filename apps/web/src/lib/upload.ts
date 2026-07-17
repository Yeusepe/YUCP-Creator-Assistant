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
}

export async function authorizeUpload(
  packageId: string,
  version: string,
  catalogProductId?: string
): Promise<UploadAuthorization> {
  return await apiClient.post<UploadAuthorization>('/api/creator/uploads/authorize', {
    packageId,
    version,
    ...(catalogProductId ? { catalogProductId } : {}),
  });
}

export async function uploadPackageFile(input: {
  file: File;
  packageId: string;
  version: string;
  catalogProductId?: string;
  onProgress?: (percent: number) => void;
  onError?: (error: Error) => void;
  onSuccess?: () => void;
}): Promise<Upload> {
  const authorization = await authorizeUpload(
    input.packageId,
    input.version,
    input.catalogProductId
  );
  const catalogProductId = authorization.catalogProductId ?? input.catalogProductId;
  const span = startHyperdxBrowserSpan('creator.upload', {
    packageId: input.packageId,
    version: input.version,
    versionId: authorization.versionId,
    byteSize: input.file.size,
  });
  const upload = new Upload(input.file, {
    endpoint: authorization.tusEndpoint,
    headers: authorization.headers,
    chunkSize: UPLOAD_CHUNK_BYTES,
    retryDelays: [0, 1_000, 3_000, 5_000, 10_000],
    removeFingerprintOnSuccess: true,
    metadata: {
      filename: input.file.name,
      filetype: input.file.type || 'application/octet-stream',
      packageId: input.packageId,
      version: input.version,
      ...(catalogProductId ? { catalogProductId } : {}),
    },
    onProgress(bytesUploaded, bytesTotal) {
      input.onProgress?.(bytesTotal === 0 ? 0 : (bytesUploaded / bytesTotal) * 100);
    },
    onError(error) {
      span.fail(error);
      input.onError?.(error);
    },
    onSuccess() {
      span.end({ byteSize: input.file.size });
      input.onSuccess?.();
    },
  });

  upload.start();
  return upload;
}
