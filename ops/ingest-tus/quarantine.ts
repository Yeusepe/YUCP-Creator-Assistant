import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Catalog, PackageQuarantineObject } from '../catalog';
import type { CasConfig } from '../storage-core/config';
import { S3ExactStoragePort } from '../storage-core/exactStorage';
import type { ProtectionPolicyId } from '../storage-core/protectionPolicyId';
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
  getExactVersion(objectKey: string, providerVersion: string): Promise<Response>;
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
  creatorId: string;
  path: string;
  protectionPolicyId: ProtectionPolicyId;
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
    creatorId: input.creatorId,
    objectKey,
    protectionPolicyId: input.protectionPolicyId,
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

function checkpointExtension(checkpoint: PackageQuarantineObject): string {
  const extension = extname(checkpoint.objectKey).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error('Quarantine checkpoint extension is invalid');
  }
  return extension;
}

async function restoreCheckpointFile(input: {
  checkpoint: PackageQuarantineObject;
  outputPath: string;
  signal?: AbortSignal;
  storage: QuarantineStoragePort;
}): Promise<void> {
  input.signal?.throwIfAborted();
  const { checkpoint } = input;
  if (
    checkpoint.state !== 'COMMITTED' ||
    !checkpoint.fileIdentifier ||
    !checkpoint.providerVersion
  ) {
    throw new Error('Quarantine checkpoint is not committed');
  }
  await verifyExactQuarantineObject({
    bytes: checkpoint.bytes,
    contentType: checkpoint.contentType,
    objectKey: checkpoint.objectKey,
    sha256: checkpoint.sha256,
    storage: input.storage,
    version: {
      fileIdentifier: checkpoint.fileIdentifier,
      providerVersion: checkpoint.providerVersion,
    },
  });
  input.signal?.throwIfAborted();
  const response = await input.storage.getExactVersion(
    checkpoint.objectKey,
    checkpoint.providerVersion
  );
  if (!response.body) {
    throw new Error('Quarantine exact object returned an empty response body');
  }

  let bytes = 0;
  const digest = createHash('sha256');
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as unknown as NodeReadableStream),
    verifier,
    createWriteStream(input.outputPath, { flags: 'wx' }),
    { signal: input.signal }
  );
  if (bytes !== checkpoint.bytes || digest.digest('hex') !== checkpoint.sha256) {
    throw new Error('Restored quarantine object failed content verification');
  }
}

export async function withRestoredCompletedUpload<T>(input: {
  checkpoint: PackageQuarantineObject;
  operation: (path: string) => Promise<T>;
  scratchRoot: string;
  signal?: AbortSignal;
  storage: QuarantineStoragePort;
}): Promise<T> {
  input.signal?.throwIfAborted();
  const requestedScratchRoot = input.scratchRoot.trim();
  if (!requestedScratchRoot) {
    throw new Error('Quarantine recovery scratch root is invalid');
  }
  const scratchRoot = resolve(requestedScratchRoot);
  await mkdir(scratchRoot, { recursive: true });
  const scratchPath = await mkdtemp(join(scratchRoot, 'quarantine-redrive-'));
  try {
    const path = join(scratchPath, `package${checkpointExtension(input.checkpoint)}`);
    await restoreCheckpointFile({
      checkpoint: input.checkpoint,
      outputPath: path,
      signal: input.signal,
      storage: input.storage,
    });
    input.signal?.throwIfAborted();
    return await input.operation(path);
  } finally {
    await rm(scratchPath, { force: true, recursive: true });
  }
}

export function createS3QuarantineStorage(config: CasConfig): QuarantineStoragePort {
  const storage = new S3ExactStoragePort({ quarantine: config });
  return {
    getExactVersion(objectKey, providerVersion) {
      return storage.getExactVersion({
        objectKey,
        providerVersion,
        role: 'quarantine',
      });
    },
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
