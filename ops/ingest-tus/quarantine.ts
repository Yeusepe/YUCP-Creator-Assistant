import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { Catalog, PackageQuarantineObject } from '../catalog';
import type { CasConfig } from '../storage-core/config';
import { S3ExactStoragePort } from '../storage-core/exactStorage';
import { S3MultipartCompletionUncertainError } from '../storage-core/s3Control';

const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ALLOWED_EXTENSIONS = new Set(['.spp', '.unitypackage', '.zip']);

export type QuarantineExactVersion = {
  fileIdentifier: string;
  providerVersion: string;
};

export type QuarantineExactHead = QuarantineExactVersion & {
  contentLength: number;
  contentType: string | null;
  metadata: Record<string, string>;
};

export interface QuarantineStoragePort {
  headExactVersion(objectKey: string, providerVersion: string): Promise<QuarantineExactHead>;
  listVersions(objectKey: string): Promise<QuarantineExactVersion[]>;
  putFile(input: {
    bytes: number;
    contentType: string;
    objectKey: string;
    path: string;
    sha256: string;
  }): Promise<QuarantineExactVersion>;
}

export type QuarantineCatalogPort = Pick<
  Catalog,
  'beginQuarantineObject' | 'commitQuarantineObject' | 'markQuarantineObjectUncertain'
>;

async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
  }
  return digest.digest('hex');
}

function quarantineObjectKey(versionId: string, sha256: string, path: string): string {
  if (!VERSION_ID.test(versionId) || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error('Quarantine upload identity is invalid');
  }
  const extension = extname(path).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error('Quarantine upload extension is invalid');
  }
  return `raw/${versionId}/${sha256}${extension}`;
}

async function verifyExactQuarantineObject(input: {
  bytes: number;
  contentType: string;
  objectKey: string;
  sha256: string;
  storage: QuarantineStoragePort;
  version: QuarantineExactVersion;
}): Promise<void> {
  const head = await input.storage.headExactVersion(input.objectKey, input.version.providerVersion);
  if (
    head.providerVersion !== input.version.providerVersion ||
    head.fileIdentifier !== input.version.fileIdentifier ||
    head.contentLength !== input.bytes ||
    head.contentType !== input.contentType ||
    head.metadata['yucp-sha256'] !== input.sha256
  ) {
    throw new Error('Quarantine exact object failed verification');
  }
}

export async function persistCompletedUpload(input: {
  catalog: QuarantineCatalogPort;
  contentType: string;
  path: string;
  storage: QuarantineStoragePort;
  versionId: string;
}): Promise<PackageQuarantineObject> {
  const details = await stat(input.path);
  if (!details.isFile() || details.size < 0) {
    throw new Error('Completed upload is not a regular file');
  }
  const sha256 = await sha256File(input.path);
  const objectKey = quarantineObjectKey(input.versionId, sha256, input.path);
  const intent = await input.catalog.beginQuarantineObject({
    bytes: details.size,
    contentType: input.contentType,
    objectKey,
    sha256,
    versionId: input.versionId,
  });
  if (intent.state === 'COMMITTED' && intent.providerVersion && intent.fileIdentifier) {
    await verifyExactQuarantineObject({
      bytes: intent.bytes,
      contentType: intent.contentType,
      objectKey: intent.objectKey,
      sha256: intent.sha256,
      storage: input.storage,
      version: {
        fileIdentifier: intent.fileIdentifier,
        providerVersion: intent.providerVersion,
      },
    });
    return intent;
  }

  const existing = await input.storage.listVersions(objectKey);
  if (existing.length > 1) {
    throw new Error('Quarantine write intent resolved to multiple object versions');
  }
  let exact = existing[0];
  if (!exact) {
    try {
      exact = await input.storage.putFile({
        bytes: details.size,
        contentType: input.contentType,
        objectKey,
        path: input.path,
        sha256,
      });
    } catch (error) {
      if (error instanceof S3MultipartCompletionUncertainError) {
        await input.catalog.markQuarantineObjectUncertain(input.versionId);
      }
      throw error;
    }
  }
  await verifyExactQuarantineObject({
    bytes: details.size,
    contentType: input.contentType,
    objectKey,
    sha256,
    storage: input.storage,
    version: exact,
  });
  return input.catalog.commitQuarantineObject({
    fileIdentifier: exact.fileIdentifier,
    providerVersion: exact.providerVersion,
    versionId: input.versionId,
  });
}

export function createS3QuarantineStorage(config: CasConfig): QuarantineStoragePort {
  const storage = new S3ExactStoragePort({ quarantine: config });
  return {
    async headExactVersion(objectKey, providerVersion) {
      const head = await storage.headExactVersion({
        objectKey,
        providerVersion,
        role: 'quarantine',
      });
      return {
        contentLength: head.contentLength,
        contentType: head.contentType,
        fileIdentifier: head.fileIdentifier,
        metadata: head.metadata,
        providerVersion: head.providerVersion,
      };
    },
    async listVersions(objectKey) {
      return storage.listExactVersions({
        objectKey,
        role: 'quarantine',
      });
    },
    async putFile(file) {
      const exact = await storage.putFile({
        bytes: file.bytes,
        contentType: file.contentType,
        objectKey: file.objectKey,
        path: file.path,
        role: 'quarantine',
        sha256: file.sha256,
      });
      return {
        fileIdentifier: exact.fileIdentifier,
        providerVersion: exact.providerVersion,
      };
    },
  };
}
