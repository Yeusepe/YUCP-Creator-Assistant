import { describe, expect, test } from 'bun:test';
import { createLogicalReleasePublicationV4 } from './releasePublication';

describe('logical release publication', () => {
  test('is stable across source archive container changes', () => {
    const base = {
      files: [
        {
          bytes: 4096,
          classification: 'common' as const,
          normalizedPath: 'Assets/Product/shader.shader',
          sha256: '11'.repeat(32),
        },
      ],
      manifest: new TextEncoder().encode('manifest bytes'),
      packageId: 'com.yucp.product',
      version: '1.0.0',
      versionId: 'version-1',
    };
    const first = createLogicalReleasePublicationV4(base);
    const second = createLogicalReleasePublicationV4(base);

    expect(first).toEqual(second);
    expect(first.releaseRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(first.bindingRoot).toMatch(/^[0-9a-f]{64}$/);
  });

  test('changes when one logical file changes', () => {
    const first = createLogicalReleasePublicationV4({
      files: [
        {
          bytes: 1,
          classification: 'common',
          normalizedPath: 'Assets/Product/file.txt',
          sha256: '11'.repeat(32),
        },
      ],
      manifest: new TextEncoder().encode('manifest one'),
      packageId: 'com.yucp.product',
      version: '1.0.0',
      versionId: 'version-1',
    });
    const second = createLogicalReleasePublicationV4({
      files: [
        {
          bytes: 1,
          classification: 'common',
          normalizedPath: 'Assets/Product/file.txt',
          sha256: '22'.repeat(32),
        },
      ],
      manifest: new TextEncoder().encode('manifest two'),
      packageId: 'com.yucp.product',
      version: '1.0.0',
      versionId: 'version-1',
    });

    expect(first.releaseRoot).not.toBe(second.releaseRoot);
  });
});
