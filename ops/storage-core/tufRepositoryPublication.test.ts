import { describe, expect, test } from 'bun:test';
import type { StorageObjectVersion } from '../catalog/exactStorageCatalog';
import {
  publishTufRepository,
  type TufPublicationCatalogPort,
  type TufPublicationStoragePort,
  type VerifiedTufRepositoryBundle,
} from './tufRepositoryPublication';

const repositoryId = 'package-installer';
const publicationId = '3af77458-e3ec-40dd-a230-41e3a99ddf37';
const metadataVersion = 42;
const targetBody = new TextEncoder().encode('signed helper bytes');

function objectVersion(objectKey: string, sequence: number): StorageObjectVersion {
  return {
    bucketName: 'metadata',
    bytes: sequence,
    contentType: 'application/json',
    fileIdentifier: `file-${sequence}`,
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    objectKey,
    providerVersion: `version-${sequence}`,
    sha256: String(sequence).padStart(64, '0'),
    storageRole: 'metadata',
    verificationState: 'VERIFIED',
    verifiedAt: new Date('2026-07-25T00:00:00Z'),
  };
}

function bundle(): VerifiedTufRepositoryBundle {
  return {
    metadataVersion,
    repositoryId,
    root: {
      body: new TextEncoder().encode('{"signed":{"_type":"root","version":1}}'),
      path: '1.root.json',
    },
    snapshot: {
      body: new TextEncoder().encode(
        `{"signed":{"_type":"snapshot","version":${metadataVersion}}}`
      ),
      path: `${metadataVersion}.snapshot.json`,
    },
    targets: {
      body: new TextEncoder().encode(`{"signed":{"_type":"targets","version":${metadataVersion}}}`),
      path: `${metadataVersion}.targets.json`,
    },
    targetFiles: [
      {
        body: targetBody,
        contentType: 'application/octet-stream',
        path: `helper/windows-amd64/${'11'.repeat(32)}.yucp-transfer-helper.exe`,
      },
    ],
    timestamp: {
      body: new TextEncoder().encode(
        `{"signed":{"_type":"timestamp","version":${metadataVersion}}}`
      ),
      path: 'timestamp.json',
    },
    verifiedAt: new Date('2026-07-25T00:00:00Z'),
  };
}

function catalog(events: string[]): TufPublicationCatalogPort {
  const recorded = new Map<string, StorageObjectVersion>();
  return {
    async getRecordedObject(_publicationId, path) {
      return recorded.get(path) ?? null;
    },
    async markPublished(input) {
      events.push(`published:${input.publicationId}`);
      expect(Array.from(recorded.keys())).toContain('metadata/timestamp.json');
    },
    async recordObject(input) {
      events.push(`record:${input.repositoryPath}`);
      recorded.set(input.repositoryPath, input.object);
    },
    async requireReservedPublication(input) {
      expect(input).toEqual({ metadataVersion, publicationId, repositoryId });
    },
  };
}

function storage(events: string[], failTimestamp = false): TufPublicationStoragePort {
  let sequence = 0;
  return {
    async putImmutable(input) {
      sequence += 1;
      events.push(`immutable:${input.objectKey}`);
      return objectVersion(input.objectKey, sequence);
    },
    async putVersioned(input) {
      events.push(`versioned:${input.objectKey}`);
      if (failTimestamp) {
        throw new Error('timestamp write failed');
      }
      sequence += 1;
      return objectVersion(input.objectKey, sequence);
    },
  };
}

describe('TUF repository publication', () => {
  test('writes timestamp last and publishes only after recording its exact version', async () => {
    const events: string[] = [];

    await publishTufRepository({
      bundle: bundle(),
      catalog: catalog(events),
      publicationId,
      storage: storage(events),
    });

    expect(events.at(-3)).toBe(
      'versioned:v2/metadata/tuf/package-installer/metadata/timestamp.json'
    );
    expect(events.at(-2)).toBe('record:metadata/timestamp.json');
    expect(events.at(-1)).toBe(`published:${publicationId}`);
  });

  test('does not publish when the timestamp write fails', async () => {
    const events: string[] = [];

    await expect(
      publishTufRepository({
        bundle: bundle(),
        catalog: catalog(events),
        publicationId,
        storage: storage(events, true),
      })
    ).rejects.toThrow('timestamp write failed');

    expect(events).not.toContain(`published:${publicationId}`);
    expect(events).not.toContain('record:metadata/timestamp.json');
  });

  test('resumes without rewriting objects already recorded for the publication', async () => {
    const events: string[] = [];
    const existingTimestamp = objectVersion(
      'v2/metadata/tuf/package-installer/metadata/timestamp.json',
      9
    );
    const port = catalog(events);
    await port.recordObject({
      object: existingTimestamp,
      publicationId,
      repositoryPath: 'metadata/timestamp.json',
    });
    events.length = 0;

    await publishTufRepository({
      bundle: bundle(),
      catalog: port,
      publicationId,
      storage: storage(events),
    });

    expect(events).not.toContain(
      'versioned:v2/metadata/tuf/package-installer/metadata/timestamp.json'
    );
    expect(events.at(-1)).toBe(`published:${publicationId}`);
  });
});
