import { describe, expect, it } from 'bun:test';
import type { StorageObjectVersion, StorageWriteIntent } from '../catalog/exactStorageCatalog';
import { DurableExactStorage, type ExactStorageCatalogPort } from './durableExactStorage';
import type {
  ExactImmutableObjectVersion,
  ExactObjectHead,
  ExactStoragePort,
  StorageRole,
} from './exactStorage';

const body = Uint8Array.from([1, 2, 3]);
const sha256 = '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81';

function object(): StorageObjectVersion {
  return {
    bucketName: 'common',
    bytes: body.byteLength,
    contentType: 'application/octet-stream',
    fileIdentifier: 'file-version-1',
    id: 'object-version-1',
    objectKey: 'v2/common/chunks/object',
    providerVersion: 'provider-version-1',
    sha256,
    storageRole: 'common',
    verificationState: 'VERIFIED',
    verifiedAt: new Date('2026-07-24T00:00:00.000Z'),
  };
}

function head(): ExactObjectHead {
  const exact = object();
  return {
    bucketName: exact.bucketName,
    contentLength: exact.bytes,
    contentType: exact.contentType,
    etag: '"etag"',
    fileIdentifier: exact.fileIdentifier,
    metadata: { 'yucp-sha256': exact.sha256 },
    objectKey: exact.objectKey,
    providerVersion: exact.providerVersion,
    storageRole: exact.storageRole,
  };
}

function storage(calls: string[]): ExactStoragePort {
  return {
    bucketName(role: StorageRole) {
      return role;
    },
    async copyExactVersion() {
      throw new Error('Unexpected copy');
    },
    async createUploadTicket() {
      throw new Error('Unexpected ticket');
    },
    async deleteExactVersion() {
      throw new Error('Unexpected delete');
    },
    async getExactVersion() {
      throw new Error('Unexpected read');
    },
    async getRetention() {
      throw new Error('Unexpected retention read');
    },
    async headExactVersion() {
      calls.push('storage.head');
      return head();
    },
    async listExactVersions() {
      throw new Error('Unexpected list');
    },
    async putFile() {
      throw new Error('Unexpected file put');
    },
    async putImmutable(): Promise<ExactImmutableObjectVersion> {
      calls.push('storage.put');
      const exact = object();
      return {
        bucketName: exact.bucketName,
        bytes: exact.bytes,
        fileIdentifier: exact.fileIdentifier,
        objectKey: exact.objectKey,
        providerVersion: exact.providerVersion,
        sha256: exact.sha256,
        status: 'created',
        storageRole: exact.storageRole,
      };
    },
  };
}

function pendingIntent(): StorageWriteIntent {
  return {
    bucketName: 'common',
    candidateObjectVersionId: null,
    contentType: 'application/octet-stream',
    expectedBytes: body.byteLength,
    expectedSha256: sha256,
    id: 'intent-1',
    idempotencyKey: 'package:version:chunk',
    leaseGeneration: 0,
    objectKey: 'v2/common/chunks/object',
    objectVersionId: null,
    operation: 'PUT',
    ownerId: 'version-1',
    ownerKind: 'package-version',
    state: 'ISSUED',
    storageDomain: 'common:global:v2',
    storageRole: 'common',
  };
}

describe('durable exact storage', () => {
  it('reads only the exact release object version recorded by the catalog', async () => {
    const calls: string[] = [];
    const catalog = {
      async beginWriteIntent() {
        throw new Error('Unexpected write');
      },
      async commitVerifiedObject() {
        throw new Error('Unexpected commit');
      },
      async findVerifiedCanonical() {
        throw new Error('Unexpected canonical lookup');
      },
      async getCommittedObjectForIntent() {
        throw new Error('Unexpected intent lookup');
      },
      async getPackageReleaseObject() {
        calls.push('catalog.release');
        return object();
      },
      async linkPackageReleaseObject() {
        throw new Error('Unexpected release link');
      },
      async markWriteIntentUncertain() {
        throw new Error('Unexpected uncertain state');
      },
    } as ExactStorageCatalogPort;
    const exactStorage = {
      ...storage(calls),
      async getExactVersion() {
        calls.push('storage.get-exact');
        return new Response(body);
      },
    };
    const durable = new DurableExactStorage(catalog, exactStorage);

    expect(
      await (
        durable as unknown as {
          readPackageReleaseObject(input: {
            logicalDigest: string;
            logicalKind: 'chunk';
            objectKey: string;
            packageVersionId: string;
            storageRole: 'common';
          }): Promise<Uint8Array>;
        }
      ).readPackageReleaseObject({
        logicalDigest: sha256,
        logicalKind: 'chunk',
        objectKey: object().objectKey,
        packageVersionId: 'version-1',
        storageRole: 'common',
      })
    ).toEqual(body);
    expect(calls).toEqual(['catalog.release', 'storage.head', 'storage.get-exact']);
  });

  it('commits an intent before the provider call and verifies the exact version', async () => {
    const calls: string[] = [];
    const catalog: ExactStorageCatalogPort = {
      async beginWriteIntent() {
        calls.push('catalog.begin');
        return pendingIntent();
      },
      async commitVerifiedObject() {
        calls.push('catalog.commit');
        return object();
      },
      async findVerifiedCanonical() {
        calls.push('catalog.find');
        return null;
      },
      async getCommittedObjectForIntent() {
        return null;
      },
      async getPackageReleaseObject() {
        throw new Error('Unexpected release read');
      },
      async linkPackageReleaseObject() {
        calls.push('catalog.link');
      },
      async markWriteIntentUncertain() {
        calls.push('catalog.uncertain');
      },
    };
    const durable = new DurableExactStorage(catalog, storage(calls));

    expect(
      await durable.putImmutable({
        body,
        contentType: 'application/octet-stream',
        idempotencyKey: 'package:version:chunk',
        objectKey: 'v2/common/chunks/object',
        ownerId: 'version-1',
        ownerKind: 'package-version',
        storageDomain: 'common:global:v2',
        storageRole: 'common',
      })
    ).toEqual(object());
    expect(calls).toEqual([
      'catalog.begin',
      'catalog.find',
      'storage.put',
      'storage.head',
      'catalog.commit',
    ]);
  });

  it('reuses a verified canonical version without another provider write', async () => {
    const calls: string[] = [];
    const catalog: ExactStorageCatalogPort = {
      async beginWriteIntent() {
        calls.push('catalog.begin');
        return pendingIntent();
      },
      async commitVerifiedObject() {
        calls.push('catalog.commit');
        return object();
      },
      async findVerifiedCanonical() {
        calls.push('catalog.find');
        return object();
      },
      async getCommittedObjectForIntent() {
        return null;
      },
      async getPackageReleaseObject() {
        throw new Error('Unexpected release read');
      },
      async linkPackageReleaseObject() {
        calls.push('catalog.link');
      },
      async markWriteIntentUncertain() {
        throw new Error('Unexpected uncertain state');
      },
    };
    const durable = new DurableExactStorage(catalog, storage(calls));

    expect(
      await durable.putImmutable({
        body,
        contentType: 'application/octet-stream',
        idempotencyKey: 'package:version:chunk',
        objectKey: 'v2/common/chunks/object',
        ownerId: 'version-1',
        ownerKind: 'package-version',
        storageDomain: 'common:global:v2',
        storageRole: 'common',
      })
    ).toEqual(object());
    expect(calls).toEqual(['catalog.begin', 'catalog.find', 'storage.head', 'catalog.commit']);
  });
});
