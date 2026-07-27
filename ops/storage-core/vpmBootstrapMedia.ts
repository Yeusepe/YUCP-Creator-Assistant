export const MAX_VPM_BOOTSTRAP_MEDIA_BYTES = 2 * 1024 * 1024;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_OBJECT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/;

export type VpmBootstrapMediaObject = {
  bucketName: string;
  byteSize: number;
  contentType: 'image/png';
  kind: 'icon' | 'banner';
  localPath: string;
  objectKey: string;
  providerVersion: string;
  sha256: string;
};

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

export function normalizeVpmBootstrapMedia(value: unknown): VpmBootstrapMediaObject[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 2) {
    throw new Error('VPM bootstrap media must contain at most two items');
  }
  const kinds = new Set<string>();
  const media = value.map((candidate, index): VpmBootstrapMediaObject => {
    if (!isRecord(candidate)) {
      throw new Error(`VPM bootstrap media ${index} is invalid`);
    }
    if (candidate.kind !== 'icon' && candidate.kind !== 'banner') {
      throw new Error(`VPM bootstrap media ${index} kind is invalid`);
    }
    if (kinds.has(candidate.kind)) {
      throw new Error(`VPM bootstrap media contains duplicate ${candidate.kind}`);
    }
    kinds.add(candidate.kind);
    const localPath = `Documentation~/YUCP/${candidate.kind}.png`;
    if (candidate.localPath !== localPath) {
      throw new Error(`VPM bootstrap media ${index} localPath is invalid`);
    }
    if (candidate.contentType !== 'image/png') {
      throw new Error(`VPM bootstrap media ${index} contentType is invalid`);
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
    return {
      bucketName: safeStorageText(candidate.bucketName, `${index} bucketName`, 255),
      byteSize: candidate.byteSize as number,
      contentType: 'image/png',
      kind: candidate.kind,
      localPath,
      objectKey,
      providerVersion: safeStorageText(
        candidate.providerVersion,
        `${index} providerVersion`,
        1_024
      ),
      sha256: candidate.sha256,
    };
  });
  return media.sort((left, right) => left.kind.localeCompare(right.kind));
}
