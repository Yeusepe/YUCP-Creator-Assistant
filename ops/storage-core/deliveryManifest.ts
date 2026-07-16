export const DESYNC_STORAGE_FORMAT_VERSION = 'desync-uncompressed-sha256-v1';
export const DESYNC_CHUNK_AVG_KIB = 64;

export type DeliveryManifestChunk = {
  id: string;
  size: number;
};

export type DeliveryManifest = {
  storageFormatVersion: string;
  versionId: string;
  totalSize: number;
  contentType: string;
  chunkAvgKib: number;
  chunks: DeliveryManifestChunk[];
};

export type DeliveryAssemblyMetadata = {
  contentType: string;
  versionId: string;
};

const STORAGE_FORMAT_VERSION_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const VERSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CHUNK_ID_PATTERN = /^[0-9a-f]{64}$/;
const CONTENT_TYPE_PATTERN = /^[\u0020-\u007e]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertVersionId(versionId: string): void {
  if (!VERSION_ID_PATTERN.test(versionId)) {
    throw new Error('Delivery manifest versionId must be a safe object-key segment');
  }
}

function assertContentType(contentType: string): void {
  if (contentType.length > 255 || !CONTENT_TYPE_PATTERN.test(contentType)) {
    throw new Error('Delivery contentType is invalid');
  }
}

export function deliveryManifestObjectId(versionId: string): string {
  assertVersionId(versionId);
  return `${versionId}.delivery.json`;
}

export function deliveryAssemblyMetadataObjectId(versionId: string): string {
  assertVersionId(versionId);
  return `${versionId}.delivery-meta.json`;
}

export function parseDeliveryAssemblyMetadata(value: unknown): DeliveryAssemblyMetadata {
  if (!isRecord(value)) {
    throw new Error('Delivery assembly metadata must be a JSON object');
  }
  const { contentType, versionId } = value;
  if (typeof versionId !== 'string') {
    throw new Error('Delivery assembly metadata has an invalid versionId');
  }
  assertVersionId(versionId);
  if (typeof contentType !== 'string') {
    throw new Error('Delivery assembly metadata has an invalid contentType');
  }
  assertContentType(contentType);
  return { contentType, versionId };
}

export function createDeliveryAssemblyMetadata(
  input: DeliveryAssemblyMetadata
): DeliveryAssemblyMetadata {
  return parseDeliveryAssemblyMetadata(input);
}

export function parseDeliveryManifest(value: unknown): DeliveryManifest {
  if (!isRecord(value)) {
    throw new Error('Delivery manifest must be a JSON object');
  }

  const { storageFormatVersion, versionId, totalSize, contentType, chunkAvgKib, chunks } = value;
  if (
    typeof storageFormatVersion !== 'string' ||
    !STORAGE_FORMAT_VERSION_PATTERN.test(storageFormatVersion)
  ) {
    throw new Error('Delivery manifest has an invalid storageFormatVersion');
  }
  if (typeof versionId !== 'string') {
    throw new Error('Delivery manifest has an invalid versionId');
  }
  assertVersionId(versionId);
  if (!Number.isSafeInteger(totalSize) || (totalSize as number) < 0) {
    throw new Error('Delivery manifest has an invalid totalSize');
  }
  if (typeof contentType !== 'string') {
    throw new Error('Delivery manifest has an invalid contentType');
  }
  assertContentType(contentType);
  if (!Number.isSafeInteger(chunkAvgKib) || (chunkAvgKib as number) <= 0) {
    throw new Error('Delivery manifest has an invalid chunkAvgKib');
  }
  if (!Array.isArray(chunks)) {
    throw new Error('Delivery manifest has an invalid chunks list');
  }

  const parsedChunks = chunks.map((chunk, index): DeliveryManifestChunk => {
    if (!isRecord(chunk)) {
      throw new Error(`Delivery manifest chunk ${index} must be an object`);
    }
    if (typeof chunk.id !== 'string' || !CHUNK_ID_PATTERN.test(chunk.id)) {
      throw new Error(`Delivery manifest chunk ${index} has an invalid id`);
    }
    if (!Number.isSafeInteger(chunk.size) || (chunk.size as number) <= 0) {
      throw new Error(`Delivery manifest chunk ${index} has an invalid size`);
    }
    return { id: chunk.id, size: chunk.size as number };
  });
  const chunkTotal = parsedChunks.reduce((total, chunk) => total + chunk.size, 0);
  if (!Number.isSafeInteger(chunkTotal) || chunkTotal !== totalSize) {
    throw new Error('Delivery manifest chunk sizes do not equal totalSize');
  }

  return {
    storageFormatVersion,
    versionId,
    totalSize: totalSize as number,
    contentType,
    chunkAvgKib: chunkAvgKib as number,
    chunks: parsedChunks,
  };
}

export function createDeliveryManifest(input: DeliveryManifest): DeliveryManifest {
  return parseDeliveryManifest(input);
}
