import { describe, expect, it } from 'bun:test';
import { classifyPackageFiles, protectionMaterializationPolicy } from './protectionPolicy';

describe('protection policy materialization semantics', () => {
  it('keeps the existing visual policy strict', () => {
    expect(protectionMaterializationPolicy('supported-visual-assets-v1')).toEqual({
      minimumCoupledFiles: 1,
      protectedFileRequirement: 'required',
    });
  });

  it('requires every protected file under the ZIP-aware policy', () => {
    const files = [
      {
        bytes: 8,
        normalizedPath: 'Assets/Textures/tiny.png',
        path: 'tiny.png',
        sha256: '11'.repeat(32),
      },
    ];

    const strict = classifyPackageFiles({
      files,
      policyId: 'supported-visual-assets-v1',
    });
    const zipAware = classifyPackageFiles({
      files,
      policyId: 'supported-visual-assets-v2',
    });

    expect(protectionMaterializationPolicy('supported-visual-assets-v2')).toEqual({
      minimumCoupledFiles: 1,
      protectedFileRequirement: 'required',
    });
    expect(zipAware.digest).not.toBe(strict.digest);
    expect(zipAware.files).toEqual(strict.files);
  });

  it('protects ZIP files that can contain uncoupled visual source copies', () => {
    const snapshot = classifyPackageFiles({
      files: [
        {
          bytes: 128,
          normalizedPath: 'Assets/Product/source.zip',
          path: 'source.zip',
          sha256: '11'.repeat(32),
        },
      ],
      policyId: 'supported-visual-assets-v2',
    });

    expect(snapshot.files).toEqual([
      {
        bytes: 128,
        classification: 'protected',
        materializerType: 'zip',
        normalizedPath: 'Assets/Product/source.zip',
        path: 'source.zip',
        sha256: '11'.repeat(32),
      },
    ]);
  });
});
