import { createHash } from 'node:crypto';
import type {
  ExactStorageCatalog,
  PackageReleaseStorageLogicalKind,
  StorageObjectVersion,
  StorageWriteIntent,
  StorageWriteOperation,
} from '../catalog/exactStorageCatalog';
import type { ExactObjectHead, ExactStoragePort, StorageRole } from './exactStorage';

export type ExactStorageCatalogPort = Pick<
  ExactStorageCatalog,
  | 'beginWriteIntent'
  | 'commitVerifiedObject'
  | 'findVerifiedCanonical'
  | 'getCommittedObjectForIntent'
  | 'getPackageReleaseObject'
  | 'linkPackageReleaseObject'
  | 'markWriteIntentUncertain'
>;

function verifyHead(object: StorageObjectVersion, head: ExactObjectHead): void {
  if (
    head.storageRole !== object.storageRole ||
    head.bucketName !== object.bucketName ||
    head.objectKey !== object.objectKey ||
    head.providerVersion !== object.providerVersion ||
    head.fileIdentifier !== object.fileIdentifier ||
    head.contentLength !== object.bytes ||
    head.contentType !== object.contentType ||
    head.metadata['yucp-sha256'] !== object.sha256
  ) {
    throw new Error('Exact storage read-back does not match the catalog');
  }
}

export class DurableExactStorage {
  constructor(
    private readonly catalog: ExactStorageCatalogPort,
    private readonly storage: ExactStoragePort
  ) {}

  async #verify(object: StorageObjectVersion): Promise<StorageObjectVersion> {
    verifyHead(
      object,
      await this.storage.headExactVersion({
        objectKey: object.objectKey,
        providerVersion: object.providerVersion,
        role: object.storageRole,
      })
    );
    return object;
  }

  async #linkRelease(
    ownerId: string,
    releaseLink:
      | {
          logicalDigest: string;
          logicalKind: PackageReleaseStorageLogicalKind;
        }
      | undefined,
    object: StorageObjectVersion
  ): Promise<StorageObjectVersion> {
    if (releaseLink) {
      await this.catalog.linkPackageReleaseObject({
        ...releaseLink,
        objectVersionId: object.id,
        packageVersionId: ownerId,
      });
    }
    return object;
  }

  async #resolveExistingIntent(
    intent: StorageWriteIntent,
    idempotencyKey: string
  ): Promise<StorageObjectVersion | null> {
    if (intent.state !== 'COMMITTED' && intent.state !== 'UNCERTAIN') {
      return null;
    }
    const committed = await this.catalog.getCommittedObjectForIntent(idempotencyKey);
    if (committed) {
      return this.#verify(committed);
    }
    if (intent.state === 'UNCERTAIN') {
      throw new Error('Uncertain storage write requires reconciliation before retry');
    }
    throw new Error('Committed storage intent has no exact object version');
  }

  async readPackageReleaseObject(input: {
    logicalDigest: string;
    logicalKind: PackageReleaseStorageLogicalKind;
    objectKey: string;
    packageVersionId: string;
    storageRole: Extract<StorageRole, 'common' | 'metadata' | 'protected'>;
  }): Promise<Uint8Array> {
    const object = await this.catalog.getPackageReleaseObject(input);
    if (!object) {
      throw new Error('Package release exact object was not found');
    }
    if (
      object.bucketName !== this.storage.bucketName(input.storageRole) ||
      object.objectKey !== input.objectKey ||
      object.sha256 !== input.logicalDigest ||
      object.storageRole !== input.storageRole
    ) {
      throw new Error('Package release exact object does not match the requested binding');
    }
    await this.#verify(object);
    const response = await this.storage.getExactVersion({
      objectKey: object.objectKey,
      providerVersion: object.providerVersion,
      role: object.storageRole,
    });
    const body = new Uint8Array(await response.arrayBuffer());
    if (
      body.byteLength !== object.bytes ||
      createHash('sha256').update(body).digest('hex') !== object.sha256
    ) {
      throw new Error('Package release exact object body failed verification');
    }
    return body;
  }

  async putImmutable(input: {
    body: Uint8Array | string;
    contentType: string;
    idempotencyKey: string;
    leaseGeneration?: number;
    objectKey: string;
    ownerId: string;
    ownerKind: StorageWriteIntent['ownerKind'];
    releaseLink?: {
      logicalDigest: string;
      logicalKind: PackageReleaseStorageLogicalKind;
    };
    storageDomain?: string;
    storageRole: Extract<StorageRole, 'common' | 'metadata' | 'protected'>;
  }): Promise<StorageObjectVersion> {
    const body =
      typeof input.body === 'string'
        ? Uint8Array.from(Buffer.from(input.body))
        : Uint8Array.from(input.body);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const operation: StorageWriteOperation = 'PUT';
    const intent = await this.catalog.beginWriteIntent({
      bucketName: this.storage.bucketName(input.storageRole),
      contentType: input.contentType,
      expectedBytes: body.byteLength,
      expectedSha256: sha256,
      idempotencyKey: input.idempotencyKey,
      leaseGeneration: input.leaseGeneration,
      objectKey: input.objectKey,
      operation,
      ownerId: input.ownerId,
      ownerKind: input.ownerKind,
      storageDomain: input.storageDomain,
      storageRole: input.storageRole,
    });
    const existing = await this.#resolveExistingIntent(intent, input.idempotencyKey);
    if (existing) {
      return this.#linkRelease(input.ownerId, input.releaseLink, existing);
    }
    if (input.storageDomain) {
      const reusable = await this.catalog.findVerifiedCanonical({
        bytes: body.byteLength,
        intentId: intent.id,
        sha256,
        storageDomain: input.storageDomain,
        storageRole: input.storageRole,
      });
      if (
        reusable &&
        reusable.bucketName === this.storage.bucketName(input.storageRole) &&
        reusable.objectKey === input.objectKey &&
        reusable.contentType === input.contentType
      ) {
        const verified = await this.#verify(reusable);
        return this.#linkRelease(
          input.ownerId,
          input.releaseLink,
          await this.catalog.commitVerifiedObject({
            fileIdentifier: verified.fileIdentifier,
            intentId: intent.id,
            providerVersion: verified.providerVersion,
          })
        );
      }
    }

    let providerCallStarted = false;
    let committedObject: StorageObjectVersion | undefined;
    try {
      providerCallStarted = true;
      const exact = await this.storage.putImmutable({
        body,
        contentType: input.contentType,
        objectKey: input.objectKey,
        role: input.storageRole,
      });
      const head = await this.storage.headExactVersion({
        objectKey: exact.objectKey,
        providerVersion: exact.providerVersion,
        role: exact.storageRole,
      });
      if (
        head.fileIdentifier !== exact.fileIdentifier ||
        head.contentLength !== body.byteLength ||
        head.contentType !== input.contentType ||
        head.metadata['yucp-sha256'] !== sha256
      ) {
        throw new Error('Exact storage write failed read-back verification');
      }
      committedObject = await this.catalog.commitVerifiedObject({
        fileIdentifier: exact.fileIdentifier,
        intentId: intent.id,
        providerVersion: exact.providerVersion,
      });
    } catch (error) {
      if (providerCallStarted) {
        const committed = await this.catalog.getCommittedObjectForIntent(input.idempotencyKey);
        if (committed) {
          committedObject = await this.#verify(committed);
        } else {
          try {
            await this.catalog.markWriteIntentUncertain(intent.id);
          } catch (markError) {
            throw new AggregateError(
              [error, markError],
              'Storage write failed and its intent could not become uncertain'
            );
          }
          throw error;
        }
      }
      if (!providerCallStarted) {
        throw error;
      }
    }
    if (!committedObject) {
      throw new Error('Storage write did not produce an exact object version');
    }
    return this.#linkRelease(input.ownerId, input.releaseLink, committedObject);
  }

  async putVersioned(input: {
    body: Uint8Array | string;
    contentType: string;
    idempotencyKey: string;
    leaseGeneration?: number;
    objectKey: string;
    ownerId: string;
    ownerKind: StorageWriteIntent['ownerKind'];
    storageRole: StorageRole;
  }): Promise<StorageObjectVersion> {
    const body =
      typeof input.body === 'string'
        ? Uint8Array.from(Buffer.from(input.body))
        : Uint8Array.from(input.body);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const intent = await this.catalog.beginWriteIntent({
      bucketName: this.storage.bucketName(input.storageRole),
      contentType: input.contentType,
      expectedBytes: body.byteLength,
      expectedSha256: sha256,
      idempotencyKey: input.idempotencyKey,
      leaseGeneration: input.leaseGeneration,
      objectKey: input.objectKey,
      operation: 'PUT',
      ownerId: input.ownerId,
      ownerKind: input.ownerKind,
      storageRole: input.storageRole,
    });
    const existing = await this.#resolveExistingIntent(intent, input.idempotencyKey);
    if (existing) {
      return existing;
    }

    let providerCallStarted = false;
    try {
      providerCallStarted = true;
      const exact = await this.storage.putVersioned({
        body,
        contentType: input.contentType,
        objectKey: input.objectKey,
        role: input.storageRole,
      });
      const head = await this.storage.headExactVersion({
        objectKey: exact.objectKey,
        providerVersion: exact.providerVersion,
        role: exact.storageRole,
      });
      if (
        head.fileIdentifier !== exact.fileIdentifier ||
        head.contentLength !== body.byteLength ||
        head.contentType !== input.contentType ||
        head.metadata['yucp-sha256'] !== sha256
      ) {
        throw new Error('Exact versioned storage write failed read-back verification');
      }
      return await this.catalog.commitVerifiedObject({
        fileIdentifier: exact.fileIdentifier,
        intentId: intent.id,
        providerVersion: exact.providerVersion,
      });
    } catch (error) {
      if (providerCallStarted) {
        const committed = await this.catalog.getCommittedObjectForIntent(input.idempotencyKey);
        if (committed) {
          return this.#verify(committed);
        }
        try {
          await this.catalog.markWriteIntentUncertain(intent.id);
        } catch (markError) {
          throw new AggregateError(
            [error, markError],
            'Storage write failed and its intent could not become uncertain'
          );
        }
      }
      throw error;
    }
  }
}
