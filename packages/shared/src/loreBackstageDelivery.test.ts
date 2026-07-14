import { describe, expect, it } from 'bun:test';

import { isLoreBackstageArtifactReference } from './loreBackstageDelivery';

describe('isLoreBackstageArtifactReference', () => {
  it('accepts finite byte sizes and rejects non-finite byte sizes', () => {
    const reference = {
      repositoryId: '0123456789abcdef0123456789abcdef',
      address: `${'a'.repeat(64)}-${'b'.repeat(32)}`,
      sha256: 'c'.repeat(64),
      byteSize: 42,
      uploadedAt: '2026-07-13T00:00:00.000Z',
    };

    expect(isLoreBackstageArtifactReference(reference)).toBe(true);
    expect(isLoreBackstageArtifactReference({ ...reference, byteSize: Number.NaN })).toBe(false);
    expect(
      isLoreBackstageArtifactReference({ ...reference, byteSize: Number.POSITIVE_INFINITY })
    ).toBe(false);
  });
});
