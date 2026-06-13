import { describe, expect, it } from 'bun:test';

import {
  prepareBackstageArtifactDescriptorForPublish,
  prepareBackstageArtifactForPublish,
} from './backstageVpmPackage';

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
      vpmDependencies: {
        'com.vrchat.base': '3.7.0',
      },
      yucpDeliverySourceKind: 'unitypackage',
      yucpDeliverySourceKindTrust: 'server-derived-v1',
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
    expect(artifact.metadata).toEqual({
      yucpDeliverySourceKind: 'zip',
      yucpDeliverySourceKindTrust: 'server-derived-v1',
    });
  });

  it('preserves a validated shared alias package contract under metadata.yucp', async () => {
    const artifact = await prepareBackstageArtifactForPublish({
      packageId: 'com.yucp.example',
      version: '1.2.3',
      metadata: {
        yucp: {
          kind: ' alias-v1 ',
          aliasId: ' creator-alias ',
          installStrategy: ' server-authorized ',
          importerPackage: ' com.yucp.importer ',
          minImporterVersion: ' 1.4.0 ',
          catalogProductIds: [' product-a ', 'product-b', 'product-a'],
          channel: ' stable ',
        },
        yucpDeliveryMode: 'repo-token-vpm-v1',
      },
      sourceBytes: new Uint8Array([80, 75, 3, 4]),
      sourceFileName: 'example.zip',
    });

    expect(artifact.metadata).toEqual({
      vpmDependencies: {
        'com.yucp.importer': '>=1.4.0',
      },
      yucpDeliverySourceKind: 'zip',
      yucpDeliverySourceKindTrust: 'server-derived-v1',
      yucp: {
        kind: 'alias-v1',
        aliasId: 'creator-alias',
        installStrategy: 'server-authorized',
        importerPackage: 'com.yucp.importer',
        minImporterVersion: '1.4.0',
        catalogProductIds: ['product-a', 'product-b'],
        channel: 'stable',
      },
    });
  });

  it('rejects invalid shared alias package metadata', async () => {
    await expect(
      prepareBackstageArtifactForPublish({
        packageId: 'com.yucp.example',
        version: '1.2.3',
        metadata: {
          yucp: {
            kind: 'alias-v1',
            aliasId: 'creator-alias',
            installStrategy: 'download-direct',
            importerPackage: 'com.yucp.importer',
          },
        },
        sourceBytes: new Uint8Array([80, 75, 3, 4]),
        sourceFileName: 'example.zip',
      })
    ).rejects.toThrow('metadata.yucp.installStrategy must be "server-authorized"');
  });

  it('detects ZIP uploads from bytes when the filename is omitted', async () => {
    const artifact = await prepareBackstageArtifactForPublish({
      packageId: 'com.yucp.example',
      version: '1.2.3',
      sourceBytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]),
      sourceContentType: 'application/octet-stream',
    });

    expect(artifact.sourceKind).toBe('zip');
    expect(artifact.contentType).toBe('application/zip');
    expect(artifact.deliveryName).toBe('example-1.2.3.zip');
    expect(artifact.metadata).toEqual({
      yucpDeliverySourceKind: 'zip',
      yucpDeliverySourceKindTrust: 'server-derived-v1',
    });
  });

  it('prepares large package descriptors from CDNgine source metadata without requiring bytes', () => {
    const artifact = prepareBackstageArtifactDescriptorForPublish({
      packageId: 'com.yucp.example',
      version: '1.2.3',
      description: 'Large package',
      sourceFileName: 'large.unitypackage',
      sourceSha256: 'f'.repeat(64),
      metadata: {
        yucpDeliverySourceKind: 'zip',
      },
    });

    expect(artifact).toEqual({
      contentType: 'application/octet-stream',
      deliveryName: 'large.unitypackage',
      metadata: {
        description: 'Large package',
        yucpDeliverySourceKind: 'unitypackage',
        yucpDeliverySourceKindTrust: 'server-derived-v1',
      },
      sourceKind: 'unitypackage',
      zipSha256: 'f'.repeat(64),
    });
  });
});
