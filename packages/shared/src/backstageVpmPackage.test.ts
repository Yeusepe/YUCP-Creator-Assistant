import { describe, expect, it } from 'bun:test';
import { prepareBackstageArtifactForPublish } from './backstageVpmPackage';

describe('prepareBackstageArtifactForPublish', () => {
  it('keeps unitypackage uploads raw while stripping reserved delivery metadata', async () => {
    const artifact = await prepareBackstageArtifactForPublish({
      packageId: 'com.yucp.example',
      version: '1.2.3',
      displayName: 'Example Package',
      description: 'Example description',
      unityVersion: '2022.3',
      metadata: {
        dependencies: {
          'com.vrchat.base': '3.7.0',
        },
        yucpDeliveryMode: 'repo-token-vpm-v1',
        yucpDeliverySourceKind: 'unitypackage',
      },
      sourceBytes: new Uint8Array([1, 2, 3, 4]),
      sourceFileName: 'example.unitypackage',
    });

    expect(artifact.sourceKind).toBe('unitypackage');
    expect(artifact.contentType).toBe('application/octet-stream');
    expect(artifact.deliveryName).toBe('example.unitypackage');
    expect(artifact.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(artifact.zipSha256).toMatch(/^[a-f0-9]{64}$/);

    expect(artifact.metadata).toEqual({
      description: 'Example description',
      unity: '2022.3',
      dependencies: {
        'com.vrchat.base': '3.7.0',
      },
    });
  });

  it('passes ZIP uploads through unchanged', async () => {
    const artifact = await prepareBackstageArtifactForPublish({
      packageId: 'com.yucp.example',
      version: '1.2.3',
      sourceBytes: new Uint8Array([80, 75, 3, 4]),
      sourceFileName: 'example.zip',
    });

    expect(artifact.sourceKind).toBe('zip');
    expect(artifact.contentType).toBe('application/zip');
    expect(artifact.deliveryName).toBe('example.zip');
    expect(artifact.bytes).toEqual(new Uint8Array([80, 75, 3, 4]));
    expect(artifact.metadata).toEqual({});
  });
});
