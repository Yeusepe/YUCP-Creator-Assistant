export const MAX_VPM_BOOTSTRAP_MEDIA_BYTES = 16 * 1024 * 1024;
export const MAX_VPM_BOOTSTRAP_MEDIA_ITEMS = 42;

const MAX_GALLERY_ITEMS = 8;
const MAX_PRODUCT_LINK_ITEMS = 32;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_OBJECT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/;

export type VpmBootstrapMediaContentType = 'image/jpeg' | 'image/png';
export type VpmBootstrapMediaKind = 'banner' | 'gallery' | 'icon' | 'product-link';

export type VpmBootstrapMediaObject = {
  // Storage/payload fields are absent for product links that ship no image.
  bucketName?: string;
  byteSize?: number;
  contentType?: VpmBootstrapMediaContentType;
  kind: VpmBootstrapMediaKind;
  label?: string;
  localPath?: string;
  objectKey?: string;
  ordinal?: number;
  providerVersion?: string;
  sha256?: string;
  url?: string;
};

export function vpmBootstrapMediaHasPayload(value: {
  bucketName?: unknown;
  byteSize?: unknown;
  contentType?: unknown;
  localPath?: unknown;
  objectKey?: unknown;
  providerVersion?: unknown;
  sha256?: unknown;
}): boolean {
  return (
    value.bucketName !== undefined ||
    value.byteSize !== undefined ||
    value.contentType !== undefined ||
    value.localPath !== undefined ||
    value.objectKey !== undefined ||
    value.providerVersion !== undefined ||
    value.sha256 !== undefined
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeStorageText(value: unknown, field: string, maximumBytes: number): string {
  if (typeof value !== 'string') {
    throw new Error(`VPM bootstrap media ${field} is invalid`);
  }
  const normalized = value.trim();
  if (
    !normalized ||
    new TextEncoder().encode(normalized).byteLength > maximumBytes ||
    Array.from(normalized).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw new Error(`VPM bootstrap media ${field} is invalid`);
  }
  return normalized;
}

function normalizePublicUrl(value: unknown, index: number): string {
  const text = safeStorageText(value, `${index} url`, 2_048);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`VPM bootstrap media ${index} url is invalid`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`VPM bootstrap media ${index} url is invalid`);
  }
  return url.toString();
}

function expectedLocalPath(input: {
  contentType: VpmBootstrapMediaContentType;
  kind: VpmBootstrapMediaKind;
  ordinal?: number;
}): string {
  const extension = input.contentType === 'image/png' ? 'png' : 'jpg';
  if (input.kind === 'icon' || input.kind === 'banner') {
    return `Documentation~/YUCP/${input.kind}.${extension}`;
  }
  const directory = input.kind === 'gallery' ? 'gallery' : 'product-links';
  return `Documentation~/YUCP/${directory}/${String(input.ordinal).padStart(3, '0')}.${extension}`;
}

export function normalizeVpmBootstrapMedia(value: unknown): VpmBootstrapMediaObject[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_VPM_BOOTSTRAP_MEDIA_ITEMS) {
    throw new Error(
      `VPM bootstrap media must contain at most ${MAX_VPM_BOOTSTRAP_MEDIA_ITEMS} items`
    );
  }
  const roles = new Set<string>();
  const media = value.map((candidate, index): VpmBootstrapMediaObject => {
    if (!isRecord(candidate)) {
      throw new Error(`VPM bootstrap media ${index} is invalid`);
    }
    if (
      candidate.kind !== 'icon' &&
      candidate.kind !== 'banner' &&
      candidate.kind !== 'gallery' &&
      candidate.kind !== 'product-link'
    ) {
      throw new Error(`VPM bootstrap media ${index} kind is invalid`);
    }
    const kind = candidate.kind;
    const requiresOrdinal = kind === 'gallery' || kind === 'product-link';
    const ordinal = requiresOrdinal ? candidate.ordinal : undefined;
    const maximumOrdinal = kind === 'gallery' ? MAX_GALLERY_ITEMS : MAX_PRODUCT_LINK_ITEMS;
    if (
      requiresOrdinal &&
      (!Number.isSafeInteger(ordinal) ||
        (ordinal as number) < 0 ||
        (ordinal as number) >= maximumOrdinal)
    ) {
      throw new Error(`VPM bootstrap media ${index} ordinal is invalid`);
    }
    if (!requiresOrdinal && candidate.ordinal !== undefined) {
      throw new Error(`VPM bootstrap media ${index} ordinal is invalid`);
    }
    const role = `${kind}:${ordinal ?? 0}`;
    if (roles.has(role)) {
      throw new Error(`VPM bootstrap media contains duplicate ${kind} role`);
    }
    roles.add(role);
    if (!vpmBootstrapMediaHasPayload(candidate)) {
      if (kind !== 'product-link') {
        throw new Error(`VPM bootstrap media ${index} requires an image payload`);
      }
      return {
        kind,
        label: safeStorageText(candidate.label, `${index} label`, 120),
        ordinal: ordinal as number,
        url: normalizePublicUrl(candidate.url, index),
      };
    }
    if (candidate.contentType !== 'image/png' && candidate.contentType !== 'image/jpeg') {
      throw new Error(`VPM bootstrap media ${index} contentType is invalid`);
    }
    const contentType = candidate.contentType;
    const localPath = expectedLocalPath({
      contentType,
      kind,
      ...(ordinal === undefined ? {} : { ordinal: ordinal as number }),
    });
    if (candidate.localPath !== localPath) {
      throw new Error(`VPM bootstrap media ${index} localPath is invalid`);
    }
    if (
      !Number.isSafeInteger(candidate.byteSize) ||
      (candidate.byteSize as number) < 8 ||
      (candidate.byteSize as number) > MAX_VPM_BOOTSTRAP_MEDIA_BYTES
    ) {
      throw new Error(`VPM bootstrap media ${index} byteSize is invalid`);
    }
    if (typeof candidate.sha256 !== 'string' || !SHA256_PATTERN.test(candidate.sha256)) {
      throw new Error(`VPM bootstrap media ${index} sha256 is invalid`);
    }
    const objectKey = safeStorageText(candidate.objectKey, `${index} objectKey`, 1_024);
    if (
      !SAFE_OBJECT_KEY_PATTERN.test(objectKey) ||
      objectKey.startsWith('/') ||
      objectKey.includes('//') ||
      objectKey.split('/').some((segment) => segment === '.' || segment === '..')
    ) {
      throw new Error(`VPM bootstrap media ${index} objectKey is invalid`);
    }
    const productLinkFields =
      kind === 'product-link'
        ? {
            label: safeStorageText(candidate.label, `${index} label`, 120),
            url: normalizePublicUrl(candidate.url, index),
          }
        : {};
    if (kind !== 'product-link' && (candidate.label !== undefined || candidate.url !== undefined)) {
      throw new Error(`VPM bootstrap media ${index} product link metadata is invalid`);
    }
    return {
      bucketName: safeStorageText(candidate.bucketName, `${index} bucketName`, 255),
      byteSize: candidate.byteSize as number,
      contentType,
      kind,
      localPath,
      objectKey,
      ...(ordinal === undefined ? {} : { ordinal: ordinal as number }),
      providerVersion: safeStorageText(
        candidate.providerVersion,
        `${index} providerVersion`,
        1_024
      ),
      sha256: candidate.sha256,
      ...productLinkFields,
    };
  });
  return media.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      (left.ordinal ?? 0) - (right.ordinal ?? 0) ||
      (left.localPath ?? '').localeCompare(right.localPath ?? '')
  );
}
