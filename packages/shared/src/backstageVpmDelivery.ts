export const BACKSTAGE_VPM_DELIVERY_MODE_KEY = 'yucpDeliveryMode';
export const BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_KEY = 'yucpDeliverySourceKind';
export const BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_KEY = 'yucpDeliverySourceKindTrust';
export const BACKSTAGE_VPM_ARTIFACT_KEY = 'yucpArtifactKey';

export const BACKSTAGE_VPM_DELIVERY_MODES = {
  repoTokenVpm: 'repo-token-vpm-v1',
} as const;

export const BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_MARKERS = {
  serverDerived: 'server-derived-v1',
} as const;

export const BACKSTAGE_VPM_SOURCE_KINDS = {
  unitypackage: 'unitypackage',
  zip: 'zip',
} as const;

export type BackstageVpmDeliveryMode =
  (typeof BACKSTAGE_VPM_DELIVERY_MODES)[keyof typeof BACKSTAGE_VPM_DELIVERY_MODES];
export type BackstageVpmDeliverySourceKind =
  (typeof BACKSTAGE_VPM_SOURCE_KINDS)[keyof typeof BACKSTAGE_VPM_SOURCE_KINDS];
export type BackstageVpmDeliverySourceKindTrustMarker =
  (typeof BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_MARKERS)[keyof typeof BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_MARKERS];

export const BACKSTAGE_VPM_RESERVED_METADATA_KEYS = new Set([
  'headers',
  'name',
  'url',
  'version',
  'zipSHA256',
  BACKSTAGE_VPM_ARTIFACT_KEY,
  BACKSTAGE_VPM_DELIVERY_MODE_KEY,
  BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_KEY,
  BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_KEY,
]);

export function stripBackstageVpmReservedMetadata(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  const nextMetadata = { ...metadata };
  for (const reservedKey of BACKSTAGE_VPM_RESERVED_METADATA_KEYS) {
    delete nextMetadata[reservedKey];
  }
  return nextMetadata;
}

export function inferBackstageVpmDeliverySourceKind(input: {
  deliveryName?: string;
  contentType?: string;
}): BackstageVpmDeliverySourceKind {
  const normalizedDeliveryName = input.deliveryName?.trim().toLowerCase();
  if (normalizedDeliveryName?.endsWith('.unitypackage')) {
    return BACKSTAGE_VPM_SOURCE_KINDS.unitypackage;
  }
  if (normalizedDeliveryName?.endsWith('.zip')) {
    return BACKSTAGE_VPM_SOURCE_KINDS.zip;
  }

  const normalizedContentType = input.contentType?.trim().toLowerCase();
  if (normalizedContentType === 'application/octet-stream') {
    return BACKSTAGE_VPM_SOURCE_KINDS.unitypackage;
  }
  return BACKSTAGE_VPM_SOURCE_KINDS.zip;
}

function looksLikeZip(bytes: Uint8Array | undefined): boolean {
  if (!bytes || bytes.byteLength < 4) {
    return false;
  }
  return (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08))
  );
}

function looksLikeGzip(bytes: Uint8Array | undefined): boolean {
  if (!bytes || bytes.byteLength < 2) {
    return false;
  }
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export function detectBackstageVpmDeliverySourceKind(input: {
  deliveryName?: string;
  contentType?: string;
  bytes?: Uint8Array;
}): BackstageVpmDeliverySourceKind {
  if (input.deliveryName?.trim()) {
    return inferBackstageVpmDeliverySourceKind({
      deliveryName: input.deliveryName,
      contentType: input.contentType,
    });
  }
  if (looksLikeZip(input.bytes)) {
    return BACKSTAGE_VPM_SOURCE_KINDS.zip;
  }
  if (looksLikeGzip(input.bytes)) {
    return BACKSTAGE_VPM_SOURCE_KINDS.unitypackage;
  }
  return inferBackstageVpmDeliverySourceKind({
    deliveryName: input.deliveryName,
    contentType: input.contentType,
  });
}

export function buildRepoTokenVpmDeliveryMetadata(
  sourceKind: BackstageVpmDeliverySourceKind
): Record<string, string> {
  return {
    [BACKSTAGE_VPM_DELIVERY_MODE_KEY]: BACKSTAGE_VPM_DELIVERY_MODES.repoTokenVpm,
    [BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_KEY]: sourceKind,
    [BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_KEY]:
      BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_MARKERS.serverDerived,
  };
}
