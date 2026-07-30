import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
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
const retryClaimToken = '00000000-0000-4000-8000-000000000001';

function retryClaim() {
  return {
    expiresAt: new Date('2030-01-01T00:15:00.000Z'),
    token: retryClaimToken,
  };
}

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
    async putVersioned() {
      calls.push('storage.put-versioned');
      const exact = object();
      return {
        bucketName: exact.bucketName,
        bytes: exact.bytes,
        fileIdentifier: exact.fileIdentifier,
        objectKey: exact.objectKey,
        providerVersion: exact.providerVersion,
        sha256: exact.sha256,
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
    retryClaimExpiresAt: null,
    retryClaimToken: null,
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
      async claimUncertainWriteRetry() {
        calls.push('catalog.claim-retry');
        return retryClaim();
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
      async reopenLostObjectWriteIntent() {
        throw new Error('Unexpected lost-object reopen');
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
      async claimUncertainWriteRetry() {
        calls.push('catalog.claim-retry');
        return retryClaim();
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
      async reopenLostObjectWriteIntent() {
        calls.push('catalog.reopen');
        return false;
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

  it('commits and verifies an ETag-identified version from a store without versioning', async () => {
    const etag = '9b2cf535f27731c974343645a3985328';
    const etagObject: StorageObjectVersion = {
      ...object(),
      fileIdentifier: etag,
      providerVersion: etag,
    };
    const calls: string[] = [];
    const catalog: ExactStorageCatalogPort = {
      async beginWriteIntent() {
        calls.push('catalog.begin');
        return pendingIntent();
      },
      async claimUncertainWriteRetry() {
        throw new Error('Unexpected retry claim');
      },
      async commitVerifiedObject(input) {
        calls.push('catalog.commit');
        expect(input).toMatchObject({ fileIdentifier: etag, providerVersion: etag });
        return etagObject;
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
        throw new Error('Unexpected release link');
      },
      async markWriteIntentUncertain() {
        throw new Error('Unexpected uncertain state');
      },
      async reopenLostObjectWriteIntent() {
        throw new Error('Unexpected lost-object reopen');
      },
    };
    const exactStorage = storage(calls);
    exactStorage.putImmutable = async () => {
      calls.push('storage.put');
      return {
        bucketName: etagObject.bucketName,
        bytes: etagObject.bytes,
        fileIdentifier: etag,
        objectKey: etagObject.objectKey,
        providerVersion: etag,
        sha256: etagObject.sha256,
        status: 'created',
        storageRole: etagObject.storageRole,
      };
    };
    exactStorage.headExactVersion = async ({ providerVersion }) => {
      calls.push('storage.head');
      expect(providerVersion).toBe(etag);
      return {
        ...head(),
        etag: `"${etag}"`,
        fileIdentifier: etag,
        providerVersion: etag,
      };
    };
    const durable = new DurableExactStorage(catalog, exactStorage);

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
    ).toEqual(etagObject);
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
      async claimUncertainWriteRetry() {
        throw new Error('Unexpected retry claim');
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
      async reopenLostObjectWriteIntent() {
        throw new Error('Unexpected lost-object reopen');
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

  it('creates a replaceable version through the same durable intent boundary', async () => {
    const calls: string[] = [];
    const catalog: ExactStorageCatalogPort = {
      async beginWriteIntent() {
        calls.push('catalog.begin');
        return {
          ...pendingIntent(),
          idempotencyKey: 'tuf:publication:timestamp',
          ownerId: 'publication-1',
          ownerKind: 'maintenance',
          storageDomain: null,
          storageRole: 'metadata',
        };
      },
      async claimUncertainWriteRetry() {
        throw new Error('Unexpected retry claim');
      },
      async commitVerifiedObject() {
        calls.push('catalog.commit');
        return {
          ...object(),
          bucketName: 'metadata',
          storageRole: 'metadata',
        };
      },
      async findVerifiedCanonical() {
        throw new Error('Unexpected canonical lookup');
      },
      async getCommittedObjectForIntent() {
        return null;
      },
      async getPackageReleaseObject() {
        throw new Error('Unexpected release read');
      },
      async linkPackageReleaseObject() {
        throw new Error('Unexpected release link');
      },
      async markWriteIntentUncertain() {
        calls.push('catalog.uncertain');
      },
      async reopenLostObjectWriteIntent() {
        calls.push('catalog.reopen');
        return false;
      },
    };
    const exactStorage = storage(calls);
    exactStorage.bucketName = () => 'metadata';
    exactStorage.putVersioned = async () => {
      calls.push('storage.put-versioned');
      return {
        bucketName: 'metadata',
        bytes: body.byteLength,
        fileIdentifier: object().fileIdentifier,
        objectKey: object().objectKey,
        providerVersion: object().providerVersion,
        sha256,
        storageRole: 'metadata',
      };
    };
    exactStorage.headExactVersion = async () => ({
      ...head(),
      bucketName: 'metadata',
      contentType: 'application/json',
      storageRole: 'metadata',
    });
    const durable = new DurableExactStorage(catalog, exactStorage);

    await (
      durable as DurableExactStorage & {
        putVersioned(input: {
          body: Uint8Array;
          contentType: string;
          idempotencyKey: string;
          objectKey: string;
          ownerId: string;
          ownerKind: 'maintenance';
          storageRole: 'metadata';
        }): Promise<StorageObjectVersion>;
      }
    ).putVersioned({
      body,
      contentType: 'application/json',
      idempotencyKey: 'tuf:publication:timestamp',
      objectKey: object().objectKey,
      ownerId: 'publication-1',
      ownerKind: 'maintenance',
      storageRole: 'metadata',
    });

    expect(calls).toEqual(['catalog.begin', 'storage.put-versioned', 'catalog.commit']);
  });

  it('adopts one fully verified exact version for an uncertain provider write', async () => {
    const calls: string[] = [];
    const catalog = {
      async beginWriteIntent() {
        calls.push('catalog.begin');
        return { ...pendingIntent(), state: 'UNCERTAIN' };
      },
      async claimUncertainWriteRetry() {
        calls.push('catalog.claim-retry');
        return retryClaim();
      },
      async commitVerifiedObject(input: { fileIdentifier: string; providerVersion: string }) {
        calls.push('catalog.commit');
        expect(input).toMatchObject({
          fileIdentifier: object().fileIdentifier,
          providerVersion: object().providerVersion,
          retryClaimToken,
        });
        return object();
      },
      async findVerifiedCanonical() {
        throw new Error('Unexpected canonical lookup');
      },
      async getCommittedObjectForIntent() {
        calls.push('catalog.committed');
        return null;
      },
      async getPackageReleaseObject() {
        throw new Error('Unexpected release read');
      },
      async linkPackageReleaseObject() {
        throw new Error('Unexpected release link');
      },
      async markWriteIntentUncertain() {
        throw new Error('Unexpected uncertain transition');
      },
    } as unknown as ExactStorageCatalogPort;
    const exactStorage = storage(calls);
    exactStorage.listExactVersions = async () => {
      calls.push('storage.list');
      const exact = object();
      return [
        {
          bucketName: exact.bucketName,
          fileIdentifier: exact.fileIdentifier,
          objectKey: exact.objectKey,
          providerVersion: exact.providerVersion,
          storageRole: exact.storageRole,
        },
      ];
    };
    exactStorage.getExactVersion = async () => {
      calls.push('storage.get-exact');
      return new Response(body);
    };
    const durable = new DurableExactStorage(catalog, exactStorage);

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
      'catalog.committed',
      'catalog.claim-retry',
      'storage.list',
      'storage.head',
      'storage.get-exact',
      'catalog.commit',
      'storage.head',
    ]);
  });

  it('claims and retries an uncertain write after an authoritative empty listing', async () => {
    const calls: string[] = [];
    const catalog = {
      async beginWriteIntent() {
        calls.push('catalog.begin');
        return { ...pendingIntent(), state: 'UNCERTAIN' };
      },
      async claimUncertainWriteRetry(input: { intentId: string }) {
        calls.push('catalog.claim-retry');
        expect(input.intentId).toBe(pendingIntent().id);
        return retryClaim();
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
        calls.push('catalog.committed');
        return null;
      },
      async getPackageReleaseObject() {
        throw new Error('Unexpected release read');
      },
      async linkPackageReleaseObject() {
        throw new Error('Unexpected release link');
      },
      async markWriteIntentUncertain() {
        throw new Error('Unexpected uncertain transition');
      },
    } as unknown as ExactStorageCatalogPort;
    const exactStorage = storage(calls);
    exactStorage.listExactVersions = async () => {
      calls.push('storage.list');
      return [];
    };
    const durable = new DurableExactStorage(catalog, exactStorage);

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
      'catalog.committed',
      'catalog.claim-retry',
      'storage.list',
      'catalog.find',
      'storage.put',
      'storage.head',
      'catalog.commit',
    ]);
  });

  it('returns a claimed retry to uncertain when preparation fails before the provider call', async () => {
    const calls: string[] = [];
    const catalog = {
      async beginWriteIntent() {
        calls.push('catalog.begin');
        return { ...pendingIntent(), state: 'UNCERTAIN' };
      },
      async claimUncertainWriteRetry() {
        calls.push('catalog.claim-retry');
        return retryClaim();
      },
      async commitVerifiedObject() {
        throw new Error('Unexpected commit');
      },
      async findVerifiedCanonical() {
        calls.push('catalog.find');
        throw new Error('Canonical lookup unavailable');
      },
      async getCommittedObjectForIntent() {
        calls.push('catalog.committed');
        return null;
      },
      async getPackageReleaseObject() {
        throw new Error('Unexpected release read');
      },
      async linkPackageReleaseObject() {
        throw new Error('Unexpected release link');
      },
      async markWriteIntentUncertain(_intentId: string, claimToken?: string) {
        calls.push('catalog.uncertain');
        expect(claimToken).toBe(retryClaimToken);
      },
    } as unknown as ExactStorageCatalogPort;
    const exactStorage = storage(calls);
    exactStorage.listExactVersions = async () => {
      calls.push('storage.list');
      return [];
    };
    const durable = new DurableExactStorage(catalog, exactStorage);

    await expect(
      durable.putImmutable({
        body,
        contentType: 'application/octet-stream',
        idempotencyKey: 'package:version:chunk',
        objectKey: 'v2/common/chunks/object',
        ownerId: 'version-1',
        ownerKind: 'package-version',
        storageDomain: 'common:global:v2',
        storageRole: 'common',
      })
    ).rejects.toThrow('Canonical lookup unavailable');
    expect(calls).toEqual([
      'catalog.begin',
      'catalog.committed',
      'catalog.claim-retry',
      'storage.list',
      'catalog.find',
      'catalog.committed',
      'catalog.uncertain',
    ]);
  });

  it('fails closed when multiple exact versions match an uncertain write', async () => {
    const calls: string[] = [];
    const catalog = {
      async beginWriteIntent() {
        calls.push('catalog.begin');
        return { ...pendingIntent(), state: 'UNCERTAIN' };
      },
      async claimUncertainWriteRetry() {
        calls.push('catalog.claim-retry');
        return retryClaim();
      },
      async commitVerifiedObject() {
        throw new Error('Unexpected commit');
      },
      async findVerifiedCanonical() {
        throw new Error('Unexpected canonical lookup');
      },
      async getCommittedObjectForIntent() {
        calls.push('catalog.committed');
        return null;
      },
      async getPackageReleaseObject() {
        throw new Error('Unexpected release read');
      },
      async linkPackageReleaseObject() {
        throw new Error('Unexpected release link');
      },
      async markWriteIntentUncertain(_intentId: string, claimToken?: string) {
        calls.push('catalog.uncertain');
        expect(claimToken).toBe(retryClaimToken);
      },
    } as unknown as ExactStorageCatalogPort;
    const exactStorage = storage(calls);
    exactStorage.listExactVersions = async () => {
      calls.push('storage.list');
      const exact = object();
      return [
        {
          bucketName: exact.bucketName,
          fileIdentifier: 'file-version-1',
          objectKey: exact.objectKey,
          providerVersion: 'provider-version-1',
          storageRole: exact.storageRole,
        },
        {
          bucketName: exact.bucketName,
          fileIdentifier: 'file-version-2',
          objectKey: exact.objectKey,
          providerVersion: 'provider-version-2',
          storageRole: exact.storageRole,
        },
      ];
    };
    exactStorage.headExactVersion = async ({ providerVersion }) => {
      calls.push(`storage.head:${providerVersion}`);
      return {
        ...head(),
        fileIdentifier:
          providerVersion === 'provider-version-1' ? 'file-version-1' : 'file-version-2',
        providerVersion,
      };
    };
    exactStorage.getExactVersion = async ({ providerVersion }) => {
      calls.push(`storage.get-exact:${providerVersion}`);
      return new Response(body);
    };
    const durable = new DurableExactStorage(catalog, exactStorage);

    await expect(
      durable.putImmutable({
        body,
        contentType: 'application/octet-stream',
        idempotencyKey: 'package:version:chunk',
        objectKey: 'v2/common/chunks/object',
        ownerId: 'version-1',
        ownerKind: 'package-version',
        storageDomain: 'common:global:v2',
        storageRole: 'common',
      })
    ).rejects.toThrow('multiple matching exact versions');
    expect(calls).toEqual([
      'catalog.begin',
      'catalog.committed',
      'catalog.claim-retry',
      'storage.list',
      'storage.head:provider-version-1',
      'storage.get-exact:provider-version-1',
      'storage.head:provider-version-2',
      'storage.get-exact:provider-version-2',
      'catalog.committed',
      'catalog.uncertain',
    ]);
  });

  it('fails closed when exact-version bytes do not match their asserted digest', async () => {
    const calls: string[] = [];
    const catalog = {
      async beginWriteIntent() {
        calls.push('catalog.begin');
        return { ...pendingIntent(), state: 'UNCERTAIN' };
      },
      async claimUncertainWriteRetry() {
        calls.push('catalog.claim-retry');
        return retryClaim();
      },
      async commitVerifiedObject() {
        throw new Error('Unexpected commit');
      },
      async findVerifiedCanonical() {
        throw new Error('Unexpected canonical lookup');
      },
      async getCommittedObjectForIntent() {
        calls.push('catalog.committed');
        return null;
      },
      async getPackageReleaseObject() {
        throw new Error('Unexpected release read');
      },
      async linkPackageReleaseObject() {
        throw new Error('Unexpected release link');
      },
      async markWriteIntentUncertain(_intentId: string, claimToken?: string) {
        calls.push('catalog.uncertain');
        expect(claimToken).toBe(retryClaimToken);
      },
    } as unknown as ExactStorageCatalogPort;
    const exactStorage = storage(calls);
    exactStorage.listExactVersions = async () => {
      calls.push('storage.list');
      const exact = object();
      return [
        {
          bucketName: exact.bucketName,
          fileIdentifier: exact.fileIdentifier,
          objectKey: exact.objectKey,
          providerVersion: exact.providerVersion,
          storageRole: exact.storageRole,
        },
      ];
    };
    exactStorage.getExactVersion = async () => {
      calls.push('storage.get-exact');
      return new Response(Uint8Array.from([3, 2, 1]));
    };
    const durable = new DurableExactStorage(catalog, exactStorage);

    await expect(
      durable.putImmutable({
        body,
        contentType: 'application/octet-stream',
        idempotencyKey: 'package:version:chunk',
        objectKey: 'v2/common/chunks/object',
        ownerId: 'version-1',
        ownerKind: 'package-version',
        storageDomain: 'common:global:v2',
        storageRole: 'common',
      })
    ).rejects.toThrow('body failed digest verification');
    expect(calls).toEqual([
      'catalog.begin',
      'catalog.committed',
      'catalog.claim-retry',
      'storage.list',
      'storage.head',
      'storage.get-exact',
      'catalog.committed',
      'catalog.uncertain',
    ]);
  });

  it('rewrites a committed intent whose object row was already marked DELETED', async () => {
    const calls: string[] = [];
    const catalog: ExactStorageCatalogPort = {
      async beginWriteIntent() {
        calls.push('catalog.begin');
        return { ...pendingIntent(), objectVersionId: 'object-version-1', state: 'COMMITTED' };
      },
      async claimUncertainWriteRetry() {
        calls.push('catalog.claim-retry');
        return retryClaim();
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
        calls.push('catalog.committed');
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
      async reopenLostObjectWriteIntent(input) {
        calls.push(`catalog.reopen:${input.objectVersionId}`);
        return true;
      },
    };
    const port = storage(calls);
    port.listExactVersions = async () => {
      calls.push('storage.list');
      return [];
    };
    const durable = new DurableExactStorage(catalog, port);

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
      'catalog.committed',
      'catalog.reopen:object-version-1',
      'catalog.claim-retry',
      'storage.list',
      'catalog.find',
      'storage.put',
      'storage.head',
      'catalog.commit',
    ]);
  });

  it('rewrites a committed object whose bytes were deleted from the store out-of-band', async () => {
    const calls: string[] = [];
    let committedGone = true;
    const catalog: ExactStorageCatalogPort = {
      async beginWriteIntent() {
        calls.push('catalog.begin');
        return { ...pendingIntent(), objectVersionId: 'object-version-1', state: 'COMMITTED' };
      },
      async claimUncertainWriteRetry() {
        calls.push('catalog.claim-retry');
        return retryClaim();
      },
      async commitVerifiedObject() {
        calls.push('catalog.commit');
        committedGone = false;
        return object();
      },
      async findVerifiedCanonical() {
        calls.push('catalog.find');
        return null;
      },
      async getCommittedObjectForIntent() {
        calls.push('catalog.committed');
        return committedGone ? object() : null;
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
      async reopenLostObjectWriteIntent() {
        calls.push('catalog.reopen');
        committedGone = false;
        return true;
      },
    };
    let heads = 0;
    const port = storage(calls);
    port.headExactVersion = async () => {
      heads += 1;
      calls.push('storage.head');
      if (heads === 1) {
        throw new Error('S3 HeadObjectVersion failed with HTTP status 403');
      }
      return head();
    };
    port.listExactVersions = async () => {
      calls.push('storage.list');
      return [];
    };
    const durable = new DurableExactStorage(catalog, port);

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
      'catalog.committed',
      'storage.head',
      'catalog.reopen',
      'catalog.claim-retry',
      'storage.list',
      'catalog.find',
      'storage.put',
      'storage.head',
      'catalog.commit',
    ]);
  });

  it('skips the write read-back head when the provider proved the write', async () => {
    const calls: string[] = [];
    const catalog: ExactStorageCatalogPort = {
      async beginWriteIntent() {
        calls.push('catalog.begin');
        return pendingIntent();
      },
      async claimUncertainWriteRetry() {
        throw new Error('Unexpected retry claim');
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
        throw new Error('Unexpected uncertain state');
      },
      async reopenLostObjectWriteIntent() {
        throw new Error('Unexpected lost-object reopen');
      },
    };
    const exactStorage = storage(calls);
    exactStorage.putImmutable = async () => {
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
        writeProven: true,
      };
    };
    const durable = new DurableExactStorage(catalog, exactStorage);

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
    expect(calls).toEqual(['catalog.begin', 'catalog.find', 'storage.put', 'catalog.commit']);
  });
});

describe('durable exact storage batches', () => {
  const bodies = [Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5, 6])];
  const digests = bodies.map((bytes) => createHash('sha256').update(bytes).digest('hex'));

  function batchObject(index: number): StorageObjectVersion {
    return {
      ...object(),
      fileIdentifier: `file-version-${index}`,
      id: `object-version-${index}`,
      objectKey: `v2/common/chunks/object-${index}`,
      providerVersion: `provider-version-${index}`,
      sha256: digests[index] as string,
    };
  }

  function batchIntent(index: number): StorageWriteIntent {
    return {
      ...pendingIntent(),
      expectedSha256: digests[index] as string,
      id: `intent-${index}`,
      idempotencyKey: `package:version:chunk-${index}`,
      objectKey: `v2/common/chunks/object-${index}`,
    };
  }

  function batchItems() {
    return bodies.map((bytes, index) => ({
      bytes: bytes.byteLength,
      idempotencyKey: `package:version:chunk-${index}`,
      loadBody: async () => bytes,
      objectKey: `v2/common/chunks/object-${index}`,
      releaseLink: {
        logicalDigest: digests[index] as string,
        logicalKind: 'chunk' as const,
      },
      sha256: digests[index] as string,
    }));
  }

  it('writes fresh batches with zero read-back heads on the proven path', async () => {
    const calls: string[] = [];
    const catalog: ExactStorageCatalogPort = {
      async beginWriteIntent() {
        throw new Error('Unexpected single-write begin');
      },
      async beginWriteIntentBatch(inputs) {
        calls.push(`catalog.begin-batch:${inputs.length}`);
        return inputs.map((_, index) => batchIntent(index));
      },
      async claimUncertainWriteRetry() {
        throw new Error('Unexpected retry claim');
      },
      async commitVerifiedObject() {
        throw new Error('Unexpected single-write commit');
      },
      async commitVerifiedObjectsBatch(input) {
        calls.push(`catalog.commit-batch:${input.entries.length}`);
        expect(input.packageVersionId).toBe('version-1');
        expect(input.entries.map((entry) => entry.providerVersion)).toEqual([
          'provider-version-0',
          'provider-version-1',
        ]);
        expect(input.entries.every((entry) => entry.releaseLink?.logicalKind === 'chunk')).toBe(
          true
        );
        return input.entries.map((entry, index) => ({
          intentId: entry.intentId,
          object: batchObject(index),
        }));
      },
      async findVerifiedCanonical() {
        throw new Error('Unexpected single canonical lookup');
      },
      async findVerifiedCanonicalBatch(input) {
        calls.push(`catalog.find-batch:${input.items.length}`);
        return input.items.map(() => null);
      },
      async getCommittedObjectForIntent() {
        throw new Error('Unexpected intent lookup');
      },
      async getPackageReleaseObject() {
        throw new Error('Unexpected release read');
      },
      async linkPackageReleaseObject() {
        throw new Error('Unexpected single release link');
      },
      async markWriteIntentUncertain() {
        throw new Error('Unexpected uncertain state');
      },
      async reopenLostObjectWriteIntent() {
        throw new Error('Unexpected lost-object reopen');
      },
    };
    const exactStorage = storage(calls);
    exactStorage.headExactVersion = async () => {
      throw new Error('Unexpected read-back head on the proven path');
    };
    exactStorage.putImmutable = async (input) => {
      const index = input.objectKey.endsWith('-0') ? 0 : 1;
      calls.push(`storage.put:${index}`);
      const exact = batchObject(index);
      return {
        bucketName: exact.bucketName,
        bytes: exact.bytes,
        fileIdentifier: exact.fileIdentifier,
        objectKey: exact.objectKey,
        providerVersion: exact.providerVersion,
        sha256: exact.sha256,
        status: 'created',
        storageRole: exact.storageRole,
        writeProven: true,
      };
    };
    const durable = new DurableExactStorage(catalog, exactStorage);

    const results = await durable.putImmutableBatch({
      contentType: 'application/octet-stream',
      items: batchItems(),
      ownerId: 'version-1',
      ownerKind: 'package-version',
      storageDomain: 'common:global:v2',
      storageRole: 'common',
    });

    expect(results).toEqual([batchObject(0), batchObject(1)]);
    expect(calls[0]).toBe('catalog.begin-batch:2');
    expect(calls[1]).toBe('catalog.find-batch:2');
    expect(calls.at(-1)).toBe('catalog.commit-batch:2');
    expect(calls.filter((call) => call.startsWith('storage.put')).sort()).toEqual([
      'storage.put:0',
      'storage.put:1',
    ]);
  });

  it('reuses verified canonical objects and reconciles non-fresh intents singly', async () => {
    const calls: string[] = [];
    const canonical: StorageObjectVersion = {
      ...object(),
      objectKey: 'v2/common/chunks/object-0',
      sha256: digests[0] as string,
    };
    const committedExisting: StorageObjectVersion = {
      ...object(),
      fileIdentifier: 'file-version-1',
      id: 'object-version-1',
      objectKey: 'v2/common/chunks/object-1',
      providerVersion: 'provider-version-1',
      sha256: digests[1] as string,
    };
    const catalog: ExactStorageCatalogPort = {
      async beginWriteIntent() {
        calls.push('catalog.begin');
        return { ...batchIntent(1), objectVersionId: 'object-version-1', state: 'COMMITTED' };
      },
      async beginWriteIntentBatch(inputs) {
        calls.push(`catalog.begin-batch:${inputs.length}`);
        return [
          batchIntent(0),
          { ...batchIntent(1), objectVersionId: 'object-version-1', state: 'COMMITTED' },
        ];
      },
      async claimUncertainWriteRetry() {
        throw new Error('Unexpected retry claim');
      },
      async commitVerifiedObject() {
        throw new Error('Unexpected single-write commit');
      },
      async commitVerifiedObjectsBatch(input) {
        calls.push(`catalog.commit-batch:${input.entries.length}`);
        expect(input.entries).toEqual([
          {
            fileIdentifier: canonical.fileIdentifier,
            intentId: 'intent-0',
            providerVersion: canonical.providerVersion,
            releaseLink: { logicalDigest: digests[0] as string, logicalKind: 'chunk' },
          },
        ]);
        return [{ intentId: 'intent-0', object: canonical }];
      },
      async findVerifiedCanonical() {
        throw new Error('Unexpected single canonical lookup');
      },
      async findVerifiedCanonicalBatch(input) {
        calls.push(`catalog.find-batch:${input.items.length}`);
        return [canonical];
      },
      async getCommittedObjectForIntent() {
        calls.push('catalog.committed');
        return committedExisting;
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
      async reopenLostObjectWriteIntent() {
        throw new Error('Unexpected lost-object reopen');
      },
    };
    const exactStorage = storage(calls);
    exactStorage.putImmutable = async () => {
      throw new Error('Unexpected provider write for reused objects');
    };
    exactStorage.headExactVersion = async ({ objectKey, providerVersion }) => {
      calls.push(`storage.head:${objectKey}`);
      const source = objectKey === canonical.objectKey ? canonical : committedExisting;
      expect(providerVersion).toBe(source.providerVersion);
      return {
        bucketName: source.bucketName,
        contentLength: source.bytes,
        contentType: source.contentType,
        etag: '"etag"',
        fileIdentifier: source.fileIdentifier,
        metadata: { 'yucp-sha256': source.sha256 },
        objectKey: source.objectKey,
        providerVersion: source.providerVersion,
        storageRole: source.storageRole,
      };
    };
    const durable = new DurableExactStorage(catalog, exactStorage);

    const results = await durable.putImmutableBatch({
      contentType: 'application/octet-stream',
      items: batchItems(),
      ownerId: 'version-1',
      ownerKind: 'package-version',
      storageDomain: 'common:global:v2',
      storageRole: 'common',
    });

    expect(results).toEqual([canonical, committedExisting]);
    expect(calls).toEqual([
      'catalog.begin-batch:2',
      'catalog.begin',
      'catalog.committed',
      `storage.head:${committedExisting.objectKey}`,
      'catalog.link',
      'catalog.find-batch:1',
      `storage.head:${canonical.objectKey}`,
      'catalog.commit-batch:1',
    ]);
  });
});
