import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { StorageObjectVersion } from '../catalog/exactStorageCatalog';
import { ExactTufRepositoryReader, type TufRepositoryReadStoragePort } from './tufRepositoryReader';

const body = new TextEncoder().encode('{"signed":"timestamp"}');
const digest = createHash('sha256').update(body).digest('hex');
const object: StorageObjectVersion = {
  bucketName: 'metadata',
  bytes: body.byteLength,
  contentType: 'application/json',
  fileIdentifier: 'file-1',
  id: 'object-1',
  objectKey: 'v2/metadata/tuf/package-installer/metadata/timestamp.json',
  providerVersion: 'version-1',
  sha256: digest,
  storageRole: 'metadata',
  verificationState: 'VERIFIED',
  verifiedAt: new Date('2026-07-25T00:00:00Z'),
};

describe('exact TUF repository reader', () => {
  test('reads and hashes only the published exact object version', async () => {
    const calls: string[] = [];
    const reader = new ExactTufRepositoryReader({
      catalog: {
        async getPublishedObject(repositoryId, repositoryPath) {
          calls.push(`catalog:${repositoryId}:${repositoryPath}`);
          return object;
        },
      },
      repositoryId: 'package-installer',
      storage: {
        bucketName() {
          return 'metadata';
        },
        async getExactVersion(input) {
          calls.push(`get:${input.providerVersion}`);
          return new Response(body);
        },
        async headExactVersion(input) {
          calls.push(`head:${input.providerVersion}`);
          return {
            bucketName: object.bucketName,
            contentLength: object.bytes,
            contentType: object.contentType,
            etag: '"etag"',
            fileIdentifier: object.fileIdentifier,
            metadata: { 'yucp-sha256': object.sha256 },
            objectKey: object.objectKey,
            providerVersion: object.providerVersion,
            storageRole: object.storageRole,
          };
        },
      } satisfies TufRepositoryReadStoragePort,
    });

    expect(await reader.read('metadata', 'timestamp.json')).toEqual({
      body,
      contentType: 'application/json',
    });
    expect(calls).toEqual([
      'catalog:package-installer:metadata/timestamp.json',
      'head:version-1',
      'get:version-1',
    ]);
  });

  test('does not issue a storage read for an unpublished path', async () => {
    let storageReads = 0;
    const reader = new ExactTufRepositoryReader({
      catalog: {
        async getPublishedObject() {
          return null;
        },
      },
      repositoryId: 'package-installer',
      storage: {
        bucketName() {
          return 'metadata';
        },
        async getExactVersion() {
          storageReads += 1;
          throw new Error('Unexpected storage read');
        },
        async headExactVersion() {
          storageReads += 1;
          throw new Error('Unexpected storage read');
        },
      } satisfies TufRepositoryReadStoragePort,
    });

    expect(await reader.read('targets', 'missing-target')).toBeNull();
    expect(storageReads).toBe(0);
  });
});
