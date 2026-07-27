import { describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { createVpmAliasArtifactStore } from './vpmAliasArtifactStore';

const PACKAGE_ID = 'com.yucp.jammr';
const PUBLICATION_ID = '00000000-0000-4000-8000-000000000001';
const BOOTSTRAP_VERSION = '1.0.0';
const ZIP_BYTES = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02, 0x03]);
const ZIP_SHA256 = createHash('sha256').update(ZIP_BYTES).digest('hex');

function createPorts(body = ZIP_BYTES) {
  const putImmutable = mock(async (input: { objectKey: string }) => ({
    bucketName: 'metadata',
    bytes: ZIP_BYTES.byteLength,
    contentType: 'application/zip',
    fileIdentifier: 'exact-version-1',
    id: 'object-version-1',
    objectKey: input.objectKey,
    providerVersion: 'exact-version-1',
    sha256: ZIP_SHA256,
    storageRole: 'metadata' as const,
    verificationState: 'VERIFIED' as const,
    verifiedAt: new Date(),
  }));
  const headExactVersion = mock(async (input: { objectKey: string }) => ({
    bucketName: 'metadata',
    contentLength: ZIP_BYTES.byteLength,
    contentType: 'application/zip',
    etag: '"etag"',
    fileIdentifier: 'exact-version-1',
    metadata: { 'yucp-sha256': ZIP_SHA256 },
    objectKey: input.objectKey,
    providerVersion: 'exact-version-1',
    storageRole: 'metadata' as const,
  }));
  const getExactVersion = mock(async () => new Response(Uint8Array.from(body)));
  return {
    durableStorage: { putImmutable },
    exactStorage: {
      bucketName: () => 'metadata',
      getExactVersion,
      headExactVersion,
    },
    getExactVersion,
    headExactVersion,
    putImmutable,
  };
}

describe('VPM alias artifact store', () => {
  it('publishes one immutable ZIP through the durable exact-storage workflow', async () => {
    const ports = createPorts();
    const store = createVpmAliasArtifactStore({
      durableStorage: ports.durableStorage as never,
      exactStorage: ports.exactStorage as never,
      indexPrefix: 'indexes/',
    });

    const artifact = await store.publish({
      body: ZIP_BYTES,
      bootstrapVersion: BOOTSTRAP_VERSION,
      packageId: PACKAGE_ID,
      publicationId: PUBLICATION_ID,
      sha256: ZIP_SHA256,
    });

    const packageDigest = createHash('sha256').update(PACKAGE_ID, 'utf8').digest('hex');
    const expectedObjectKey = `indexes/vpm/aliases/${packageDigest}/${PUBLICATION_ID}/${BOOTSTRAP_VERSION}.zip`;
    expect(ports.putImmutable).toHaveBeenCalledWith({
      body: ZIP_BYTES,
      contentType: 'application/zip',
      idempotencyKey: `vpm-alias-publication:${PUBLICATION_ID}:${ZIP_SHA256}`,
      objectKey: expectedObjectKey,
      ownerId: PUBLICATION_ID,
      ownerKind: 'vpm-alias-publication',
      storageRole: 'metadata',
    });
    expect(artifact).toEqual({
      bucketName: 'metadata',
      byteSize: ZIP_BYTES.byteLength,
      contentType: 'application/zip',
      objectKey: expectedObjectKey,
      providerVersion: 'exact-version-1',
      sha256: ZIP_SHA256,
    });
  });

  it('reads only the recorded provider version and verifies the complete body', async () => {
    const ports = createPorts();
    const store = createVpmAliasArtifactStore({
      durableStorage: ports.durableStorage as never,
      exactStorage: ports.exactStorage as never,
      indexPrefix: 'indexes/',
    });
    const reference = {
      bucketName: 'metadata',
      byteSize: ZIP_BYTES.byteLength,
      contentType: 'application/zip' as const,
      objectKey: `indexes/vpm/aliases/package/${PUBLICATION_ID}/${BOOTSTRAP_VERSION}.zip`,
      providerVersion: 'exact-version-1',
      sha256: ZIP_SHA256,
    };

    const body = await store.readExact(reference);

    expect(body).toEqual(ZIP_BYTES);
    expect(ports.headExactVersion).toHaveBeenCalledWith({
      objectKey: reference.objectKey,
      providerVersion: 'exact-version-1',
      role: 'metadata',
    });
    expect(ports.getExactVersion).toHaveBeenCalledWith({
      objectKey: reference.objectKey,
      providerVersion: 'exact-version-1',
      role: 'metadata',
    });
  });

  it('rejects a corrupt exact body without returning partial content', async () => {
    const ports = createPorts(Uint8Array.from([0x50, 0x4b, 0x00]));
    const store = createVpmAliasArtifactStore({
      durableStorage: ports.durableStorage as never,
      exactStorage: ports.exactStorage as never,
      indexPrefix: 'indexes/',
    });

    await expect(
      store.readExact({
        bucketName: 'metadata',
        byteSize: ZIP_BYTES.byteLength,
        contentType: 'application/zip',
        objectKey: `indexes/vpm/aliases/package/${PUBLICATION_ID}/${BOOTSTRAP_VERSION}.zip`,
        providerVersion: 'exact-version-1',
        sha256: ZIP_SHA256,
      })
    ).rejects.toThrow('VPM alias artifact body failed verification');
  });
});
