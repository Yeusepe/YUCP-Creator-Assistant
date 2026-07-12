import type { LoreBackstageArtifactReference } from '@yucp/shared/loreBackstageDelivery';

export type BackstageUploadClaims = {
  typ: 'backstage-upload';
  authUserId: string;
  packageId: string;
  version: string;
  repositoryId: string;
  deliveryName: string;
  sourceContentType: string;
  declaredSha256: string;
  byteSize: number;
  materializeMetadata?: {
    displayName?: string;
    metadata?: Record<string, unknown>;
  };
  exp: number;
};

export type BackstageIngestResult = {
  typ: 'backstage-ingest-result';
  authUserId: string;
  packageId: string;
  version: string;
  loreSource: LoreBackstageArtifactReference;
  loreDelivery: LoreBackstageArtifactReference;
  rawSha256: string;
  rawByteSize: number;
  rawDeliveryName: string;
  rawContentType: string;
  deliverableSha256: string;
  deliverableByteSize: number;
  deliverableDeliveryName: string;
  deliverableContentType: string;
  exp: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(
  payload: Record<string, unknown>,
  field: keyof BackstageUploadClaims
): string {
  const value = payload[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Upload token ${field} must be a non-empty string.`);
  }
  return value;
}

export function parseUploadClaims(value: unknown): BackstageUploadClaims {
  if (!isRecord(value)) {
    throw new Error('Upload token payload must be an object.');
  }
  if (value.typ !== 'backstage-upload') {
    throw new Error('Upload token typ must be backstage-upload.');
  }

  const declaredSha256 = requiredString(value, 'declaredSha256').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(declaredSha256)) {
    throw new Error('Upload token declaredSha256 must be 64 hexadecimal characters.');
  }

  const repositoryId = requiredString(value, 'repositoryId');
  if (!/^[0-9a-f]{32}$/.test(repositoryId)) {
    throw new Error('Upload token repositoryId must be 32 lowercase hexadecimal characters.');
  }

  if (!Number.isSafeInteger(value.byteSize) || (value.byteSize as number) < 0) {
    throw new Error('Upload token byteSize must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(value.exp) || (value.exp as number) <= 0) {
    throw new Error('Upload token exp must be a positive integer.');
  }

  let materializeMetadata: BackstageUploadClaims['materializeMetadata'];
  if (value.materializeMetadata !== undefined) {
    if (!isRecord(value.materializeMetadata)) {
      throw new Error('Upload token materializeMetadata must be an object.');
    }
    const displayName = value.materializeMetadata.displayName;
    if (displayName !== undefined && typeof displayName !== 'string') {
      throw new Error('Upload token materializeMetadata.displayName must be a string.');
    }
    const metadata = value.materializeMetadata.metadata;
    if (metadata !== undefined && !isRecord(metadata)) {
      throw new Error('Upload token materializeMetadata.metadata must be an object.');
    }
    materializeMetadata = {
      ...(displayName !== undefined ? { displayName } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    };
  }

  return {
    typ: 'backstage-upload',
    authUserId: requiredString(value, 'authUserId'),
    packageId: requiredString(value, 'packageId'),
    version: requiredString(value, 'version'),
    repositoryId,
    deliveryName: requiredString(value, 'deliveryName'),
    sourceContentType: requiredString(value, 'sourceContentType'),
    declaredSha256,
    byteSize: value.byteSize as number,
    ...(materializeMetadata ? { materializeMetadata } : {}),
    exp: value.exp as number,
  };
}
