import { createHash } from 'node:crypto';
import type {
  ExactStorageCatalog,
  PackageReleaseStorageLogicalKind,
  StorageObjectVersion,
  StorageWriteIntent,
  StorageWriteOperation,
} from '../catalog/exactStorageCatalog';
import type { ExactObjectHead, ExactStoragePort, StorageRole } from './exactStorage';

const EXACT_WRITE_RETRY_CLAIM_MS = 15 * 60 * 1_000;

export type ExactStorageCatalogPort = Pick<
  ExactStorageCatalog,
  | 'beginWriteIntent'
  | 'claimUncertainWriteRetry'
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

  async #verifyIntentBody(intent: StorageWriteIntent, head: ExactObjectHead): Promise<void> {
    const response = await this.storage.getExactVersion({
      objectKey: head.objectKey,
      providerVersion: head.providerVersion,
      role: head.storageRole,
    });
    if (!response.body) {
      throw new Error('Exact storage version body is unavailable');
    }
    const digest = createHash('sha256');
    const reader = response.body.getReader();
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        bytes += chunk.value.byteLength;
        if (bytes > intent.expectedBytes) {
          await reader.cancel();
          throw new Error('Exact storage version body exceeded its expected length');
        }
        digest.update(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    if (bytes !== intent.expectedBytes || digest.digest('hex') !== intent.expectedSha256) {
      throw new Error('Exact storage version body failed digest verification');
    }
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
  ): Promise<{
    object: StorageObjectVersion | null;
    retryClaimToken: string | null;
  }> {
    if (
      intent.state !== 'COMMITTED' &&
      intent.state !== 'RETRYING' &&
      intent.state !== 'UNCERTAIN'
    ) {
      return { object: null, retryClaimToken: null };
    }
    const committed = await this.catalog.getCommittedObjectForIntent(idempotencyKey);
    if (committed) {
      return { object: await this.#verify(committed), retryClaimToken: null };
    }
    if (intent.state === 'UNCERTAIN' || intent.state === 'RETRYING') {
      const claim = await this.catalog.claimUncertainWriteRetry({
        claimDurationMs: EXACT_WRITE_RETRY_CLAIM_MS,
        intentId: intent.id,
      });
      if (!claim) {
        const reconciled = await this.catalog.getCommittedObjectForIntent(idempotencyKey);
        if (reconciled) {
          return { object: await this.#verify(reconciled), retryClaimToken: null };
        }
        throw new Error('Storage write reconciliation is already in progress');
      }
      try {
        const versions = await this.storage.listExactVersions({
          objectKey: intent.objectKey,
          role: intent.storageRole,
        });
        const matching: ExactObjectHead[] = [];
        for (const version of versions) {
          if (
            version.bucketName !== intent.bucketName ||
            version.objectKey !== intent.objectKey ||
            version.storageRole !== intent.storageRole
          ) {
            throw new Error('Exact storage version listing returned an invalid object binding');
          }
          const head = await this.storage.headExactVersion({
            objectKey: version.objectKey,
            providerVersion: version.providerVersion,
            role: version.storageRole,
          });
          if (
            head.bucketName !== version.bucketName ||
            head.objectKey !== version.objectKey ||
            head.providerVersion !== version.providerVersion ||
            head.fileIdentifier !== version.fileIdentifier ||
            head.storageRole !== version.storageRole
          ) {
            throw new Error('Exact storage version head does not match its listing');
          }
          if (
            head.contentLength === intent.expectedBytes &&
            head.contentType === intent.contentType &&
            head.metadata['yucp-sha256'] === intent.expectedSha256
          ) {
            await this.#verifyIntentBody(intent, head);
            matching.push(head);
          }
        }
        if (matching.length > 1) {
          throw new Error('Uncertain storage write has multiple matching exact versions');
        }
        const candidate = matching[0];
        if (candidate) {
          return {
            object: await this.#verify(
              await this.catalog.commitVerifiedObject({
                fileIdentifier: candidate.fileIdentifier,
                intentId: intent.id,
                providerVersion: candidate.providerVersion,
                retryClaimToken: claim.token,
              })
            ),
            retryClaimToken: null,
          };
        }
        return { object: null, retryClaimToken: claim.token };
      } catch (error) {
        const reconciled = await this.catalog.getCommittedObjectForIntent(idempotencyKey);
        if (reconciled) {
          return { object: await this.#verify(reconciled), retryClaimToken: null };
        }
        try {
          await this.catalog.markWriteIntentUncertain(intent.id, claim.token);
        } catch (markError) {
          throw new AggregateError(
            [error, markError],
            'Storage write reconciliation failed and could not release its claim'
          );
        }
        throw error;
      }
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
    const resolution = await this.#resolveExistingIntent(intent, input.idempotencyKey);
    if (resolution.object) {
      return this.#linkRelease(input.ownerId, input.releaseLink, resolution.object);
    }

    let providerCallStarted = false;
    let committedObject: StorageObjectVersion | undefined;
    try {
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
          committedObject = await this.catalog.commitVerifiedObject({
            fileIdentifier: verified.fileIdentifier,
            intentId: intent.id,
            providerVersion: verified.providerVersion,
            retryClaimToken: resolution.retryClaimToken ?? undefined,
          });
        }
      }
      if (!committedObject) {
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
          retryClaimToken: resolution.retryClaimToken ?? undefined,
        });
      }
    } catch (error) {
      if (providerCallStarted || resolution.retryClaimToken) {
        const committed = await this.catalog.getCommittedObjectForIntent(input.idempotencyKey);
        if (committed) {
          committedObject = await this.#verify(committed);
        } else {
          try {
            await this.catalog.markWriteIntentUncertain(
              intent.id,
              resolution.retryClaimToken ?? undefined
            );
          } catch (markError) {
            throw new AggregateError(
              [error, markError],
              'Storage write failed and its intent could not become uncertain'
            );
          }
          throw error;
        }
      }
      if (!providerCallStarted && !resolution.retryClaimToken) {
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
    releaseLink?: {
      logicalDigest: string;
      logicalKind: PackageReleaseStorageLogicalKind;
    };
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
    const resolution = await this.#resolveExistingIntent(intent, input.idempotencyKey);
    if (resolution.object) {
      return this.#linkRelease(input.ownerId, input.releaseLink, resolution.object);
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
      const committedObject = await this.catalog.commitVerifiedObject({
        fileIdentifier: exact.fileIdentifier,
        intentId: intent.id,
        providerVersion: exact.providerVersion,
        retryClaimToken: resolution.retryClaimToken ?? undefined,
      });
      return await this.#linkRelease(input.ownerId, input.releaseLink, committedObject);
    } catch (error) {
      if (providerCallStarted || resolution.retryClaimToken) {
        const committed = await this.catalog.getCommittedObjectForIntent(input.idempotencyKey);
        if (committed) {
          return this.#linkRelease(input.ownerId, input.releaseLink, await this.#verify(committed));
        }
        try {
          await this.catalog.markWriteIntentUncertain(
            intent.id,
            resolution.retryClaimToken ?? undefined
          );
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
