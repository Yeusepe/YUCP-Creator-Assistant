import { describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { storeBootstrapMediaObject } from './ingestPipeline';

describe('ingest bootstrap media storage', () => {
  it('writes one digest-addressed immutable object through the metadata role', async () => {
    const body = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const putImmutable = mock(async (input: Record<string, unknown>) => ({
      bucketName: 'metadata',
      bytes: body.byteLength,
      contentType: 'image/png',
      fileIdentifier: 'exact-version-1',
      id: 'object-version-1',
      objectKey: input.objectKey as string,
      providerVersion: 'exact-version-1',
      sha256,
      storageRole: 'metadata',
      verificationState: 'VERIFIED',
      verifiedAt: new Date(),
    }));

    const stored = await storeBootstrapMediaObject({
      body,
      contentType: 'image/png',
      kind: 'icon',
      localPath: 'Documentation~/YUCP/icon.png',
      ownerId: 'package-version-1',
      sha256,
      store: {
        config: { indexPrefix: 'indexes/' },
        durableStorage: { putImmutable },
        kind: 's3',
        storageRole: 'metadata',
      } as never,
    });

    expect(putImmutable).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: 'image/png',
        objectKey: `indexes/bootstrap-media/${sha256}.png`,
        releaseLink: { logicalDigest: sha256, logicalKind: 'bootstrap-media' },
        storageDomain: 'metadata:global:v2',
        storageRole: 'metadata',
      })
    );
    expect(stored).toMatchObject({
      bucketName: 'metadata',
      byteSize: body.byteLength,
      objectKey: `indexes/bootstrap-media/${sha256}.png`,
      providerVersion: 'exact-version-1',
      sha256,
    });
  });

  it('rejects media storage outside the exact metadata role', async () => {
    const body = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await expect(
      storeBootstrapMediaObject({
        body,
        contentType: 'image/png',
        kind: 'icon',
        localPath: 'Documentation~/YUCP/icon.png',
        ownerId: 'package-version-1',
        sha256: createHash('sha256').update(body).digest('hex'),
        store: { kind: 'local', storePath: 'unused' } as never,
      })
    ).rejects.toThrow('exact metadata-role storage');
  });
});
