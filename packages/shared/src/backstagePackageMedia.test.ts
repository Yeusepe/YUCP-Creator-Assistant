import { describe, expect, it } from 'bun:test';
import {
  BACKSTAGE_PACKAGE_MEDIA_EXTRACTION_MAX_SOURCE_BYTES,
  BACKSTAGE_PACKAGE_MEDIA_METADATA_KEY,
  canExtractBackstagePackageMediaFromSourceSize,
  getBackstagePackageMediaReferencesFromMetadata,
} from './backstagePackageMedia';

describe('backstage package media extraction source size policy', () => {
  it('allows extraction only for finite package sizes within the buffering limit', () => {
    expect(canExtractBackstagePackageMediaFromSourceSize(0)).toBe(true);
    expect(
      canExtractBackstagePackageMediaFromSourceSize(
        BACKSTAGE_PACKAGE_MEDIA_EXTRACTION_MAX_SOURCE_BYTES
      )
    ).toBe(true);
    expect(
      canExtractBackstagePackageMediaFromSourceSize(
        BACKSTAGE_PACKAGE_MEDIA_EXTRACTION_MAX_SOURCE_BYTES + 1
      )
    ).toBe(false);
    expect(canExtractBackstagePackageMediaFromSourceSize(-1)).toBe(false);
    expect(canExtractBackstagePackageMediaFromSourceSize(Number.NaN)).toBe(false);
    expect(canExtractBackstagePackageMediaFromSourceSize(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('backstage package media metadata normalization', () => {
  it('keeps media with Lore coordinates and omits media without them', () => {
    const sha256 = 'a'.repeat(64);
    const loreDelivery = {
      repositoryId: 'b'.repeat(32),
      address: `${'c'.repeat(64)}-${'d'.repeat(32)}`,
      sha256,
      byteSize: 128,
      uploadedAt: '2026-07-13T12:00:00.000Z',
      tenantId: 'auth-user-1',
    };

    expect(
      getBackstagePackageMediaReferencesFromMetadata({
        [BACKSTAGE_PACKAGE_MEDIA_METADATA_KEY]: {
          icon: {
            kind: 'icon',
            contentType: 'image/png',
            deliveryName: 'icon.png',
            sha256,
            byteSize: 128,
            loreDelivery,
          },
          banner: {
            kind: 'banner',
            contentType: 'image/png',
            deliveryName: 'banner.png',
            sha256: 'e'.repeat(64),
            byteSize: 256,
          },
        },
      })
    ).toEqual({
      icon: {
        kind: 'icon',
        contentType: 'image/png',
        deliveryName: 'icon.png',
        sha256,
        byteSize: 128,
        loreDelivery,
      },
    });
  });
});
