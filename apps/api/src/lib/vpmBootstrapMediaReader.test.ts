import { describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { createVpmBootstrapMediaReader } from './vpmBootstrapMediaReader';

const reference = {
  bucketName: 'metadata',
  byteSize: 9,
  contentType: 'image/png' as const,
  kind: 'icon' as const,
  localPath: 'Documentation~/YUCP/icon.png',
  objectKey: `indexes/bootstrap-media/${'aa'.repeat(32)}.png`,
  providerVersion: 'exact-version-1',
  sha256: 'aa'.repeat(32),
};

describe('VPM bootstrap media reader', () => {
  it('rejects a descriptor-selected metadata key before storage access', async () => {
    const headExactVersion = mock(async () => {
      throw new Error('must not run');
    });
    const getExactVersion = mock(async () => new Response());
    const reader = createVpmBootstrapMediaReader(
      {
        bucket: 'metadata',
        indexPrefix: 'indexes/',
      },
      { getExactVersion, headExactVersion }
    );

    await expect(
      reader.readExact({
        ...reference,
        objectKey: 'indexes/private/other-metadata.json',
      })
    ).rejects.toThrow('canonical bootstrap media key');
    expect(headExactVersion).not.toHaveBeenCalled();
    expect(getExactVersion).not.toHaveBeenCalled();
  });

  it('returns only the exact body that matches the descriptor digest', async () => {
    const body = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const exactReference = {
      ...reference,
      objectKey: `indexes/bootstrap-media/${sha256}.png`,
      sha256,
    };
    const reader = createVpmBootstrapMediaReader(
      { bucket: 'metadata', indexPrefix: 'indexes/' },
      {
        getExactVersion: async () => new Response(body),
        headExactVersion: async () => ({
          bucketName: 'metadata',
          contentLength: body.byteLength,
          contentType: 'image/png',
          etag: null,
          fileIdentifier: 'exact-version-1',
          metadata: { 'yucp-sha256': sha256 },
          objectKey: exactReference.objectKey,
          providerVersion: 'exact-version-1',
          storageRole: 'metadata',
        }),
      }
    );

    await expect(reader.readExact(exactReference)).resolves.toEqual(body);

    const corruptReader = createVpmBootstrapMediaReader(
      { bucket: 'metadata', indexPrefix: 'indexes/' },
      {
        getExactVersion: async () => new Response(Uint8Array.from([...body, 1])),
        headExactVersion: async () => ({
          bucketName: 'metadata',
          contentLength: body.byteLength,
          contentType: 'image/png',
          etag: null,
          fileIdentifier: 'exact-version-1',
          metadata: { 'yucp-sha256': sha256 },
          objectKey: exactReference.objectKey,
          providerVersion: 'exact-version-1',
          storageRole: 'metadata',
        }),
      }
    );
    await expect(corruptReader.readExact(exactReference)).rejects.toThrow('digest verification');
  });
});
