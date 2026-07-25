import { describe, expect, it } from 'bun:test';
import { classifyPackageFiles, protectionMaterializationPolicy } from './protectionPolicy';

describe('protection policy materialization semantics', () => {
  it('keeps the existing visual policy strict', () => {
    expect(protectionMaterializationPolicy('supported-visual-assets-v1')).toEqual({
      minimumCoupledFiles: 1,
      protectedFileRequirement: 'required',
    });
  });

  it('commits best-effort file handling to a distinct policy digest', () => {
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
    const bestEffort = classifyPackageFiles({
      files,
      policyId: 'supported-visual-assets-v2',
    });

    expect(protectionMaterializationPolicy('supported-visual-assets-v2')).toEqual({
      minimumCoupledFiles: 1,
      protectedFileRequirement: 'best-effort',
    });
    expect(bestEffort.digest).not.toBe(strict.digest);
    expect(bestEffort.files).toEqual(strict.files);
  });
});
