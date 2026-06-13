import { describe, expect, it } from 'bun:test';
import {
  BACKSTAGE_PACKAGE_MEDIA_EXTRACTION_MAX_SOURCE_BYTES,
  canExtractBackstagePackageMediaFromSourceSize,
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
