import { describe, expect, it } from 'bun:test';
import {
  ACTIVE_PROTECTION_POLICY_ID,
  classifyPackageFiles,
  isProtectionPolicyId,
  protectionMaterializationPolicy,
} from './protectionPolicy';

describe('protection policy materialization semantics', () => {
  it('recognizes only the active protection policy', () => {
    expect(isProtectionPolicyId(ACTIVE_PROTECTION_POLICY_ID)).toBe(true);
    expect(isProtectionPolicyId('common-only-v1')).toBe(false);
    expect(isProtectionPolicyId('supported-visual-assets-v1')).toBe(false);
    expect(() => protectionMaterializationPolicy('common-only-v1')).toThrow(
      'Unknown protection policy: common-only-v1'
    );
    expect(() => protectionMaterializationPolicy('supported-visual-assets-v1')).toThrow(
      'Unknown protection policy: supported-visual-assets-v1'
    );
  });

  it('uses best-effort server materialization for the active policy', () => {
    expect(protectionMaterializationPolicy(ACTIVE_PROTECTION_POLICY_ID)).toEqual({
      minimumCoupledFiles: 1,
      protectedFileRequirement: 'best-effort',
    });
  });

  it('protects supported files and keeps other files byte-exact', () => {
    const snapshot = classifyPackageFiles({
      files: [
        {
          bytes: 128,
          normalizedPath: 'Assets/Product/model.fbx',
          path: 'model.fbx',
          sha256: '11'.repeat(32),
        },
        {
          bytes: 128,
          normalizedPath: 'Assets/Product/texture.png',
          path: 'texture.png',
          pixelHeight: 1024,
          pixelWidth: 1024,
          sha256: '22'.repeat(32),
        },
        {
          bytes: 128,
          normalizedPath: 'Assets/Product/source.zip',
          path: 'source.zip',
          sha256: '33'.repeat(32),
        },
        {
          bytes: 128,
          normalizedPath: 'Assets/Product/readme.txt',
          path: 'readme.txt',
          sha256: '44'.repeat(32),
        },
      ],
      policyId: ACTIVE_PROTECTION_POLICY_ID,
    });

    expect(snapshot.files).toEqual([
      {
        bytes: 128,
        classification: 'protected',
        materializerType: 'fbx',
        normalizedPath: 'Assets/Product/model.fbx',
        path: 'model.fbx',
        sha256: '11'.repeat(32),
      },
      {
        bytes: 128,
        classification: 'protected',
        materializerType: 'png',
        normalizedPath: 'Assets/Product/texture.png',
        path: 'texture.png',
        sha256: '22'.repeat(32),
      },
      {
        bytes: 128,
        classification: 'protected',
        materializerType: 'zip',
        normalizedPath: 'Assets/Product/source.zip',
        path: 'source.zip',
        sha256: '33'.repeat(32),
      },
      {
        bytes: 128,
        classification: 'common',
        normalizedPath: 'Assets/Product/readme.txt',
        path: 'readme.txt',
        sha256: '44'.repeat(32),
      },
    ]);
    expect(snapshot.id).toBe(ACTIVE_PROTECTION_POLICY_ID);
  });

  it('protects an asset that ships deactivated by its real extension', () => {
    const snapshot = classifyPackageFiles({
      files: [
        {
          bytes: 128,
          normalizedPath: 'Assets/Product/FBX/Headphones.fbx.yucp_disabled',
          path: 'Headphones.fbx.yucp_disabled',
          sha256: '77'.repeat(32),
        },
        {
          bytes: 128,
          normalizedPath: 'Assets/Product/Textures/Skin.png.yucp_disabled',
          path: 'Skin.png.yucp_disabled',
          pixelHeight: 1024,
          pixelWidth: 1024,
          sha256: '88'.repeat(32),
        },
        {
          bytes: 128,
          normalizedPath: 'Assets/Product/FBX/Headphones.fbx.meta.yucp_disabled',
          path: 'Headphones.fbx.meta.yucp_disabled',
          sha256: '99'.repeat(32),
        },
      ],
      policyId: ACTIVE_PROTECTION_POLICY_ID,
    });

    expect(snapshot.files.map((file) => [file.classification, file.materializerType])).toEqual([
      ['protected', 'fbx'],
      ['protected', 'png'],
      ['common', undefined],
    ]);
    expect(snapshot.files[0]?.normalizedPath).toBe(
      'Assets/Product/FBX/Headphones.fbx.yucp_disabled'
    );
  });

  it('carries images too small to hold the watermark as common content', () => {
    const classify = (pixels?: { pixelHeight: number; pixelWidth: number }) =>
      classifyPackageFiles({
        files: [
          {
            bytes: 128,
            normalizedPath: 'Assets/Product/icon.png',
            path: 'icon.png',
            ...(pixels ?? {}),
            sha256: '55'.repeat(32),
          },
        ],
        policyId: ACTIVE_PROTECTION_POLICY_ID,
      }).files[0];

    expect(classify({ pixelHeight: 6, pixelWidth: 6 })?.classification).toBe('common');
    expect(classify({ pixelHeight: 256, pixelWidth: 256 })?.classification).toBe('common');
    expect(classify()?.classification).toBe('common');
    expect(classify({ pixelHeight: 512, pixelWidth: 512 })).toEqual({
      bytes: 128,
      classification: 'protected',
      materializerType: 'png',
      normalizedPath: 'Assets/Product/icon.png',
      path: 'icon.png',
      sha256: '55'.repeat(32),
    });
  });
});
