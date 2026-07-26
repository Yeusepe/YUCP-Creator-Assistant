import type { StorageObjectVersion } from '../catalog/exactStorageCatalog';

const REPOSITORY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const ROOT_PATH_PATTERN = /^[1-9][0-9]*\.root\.json$/;

export type VerifiedTufRepositoryFile = {
  body: Uint8Array;
  path: string;
};

export type VerifiedTufRepositoryTarget = VerifiedTufRepositoryFile & {
  contentType: string;
};

export type VerifiedTufRepositoryBundle = {
  metadataVersion: number;
  repositoryId: string;
  root: VerifiedTufRepositoryFile;
  snapshot: VerifiedTufRepositoryFile;
  targets: VerifiedTufRepositoryFile;
  targetFiles: VerifiedTufRepositoryTarget[];
  timestamp: VerifiedTufRepositoryFile;
  verifiedAt: Date;
};

export interface TufPublicationCatalogPort {
  getRecordedObject(
    publicationId: string,
    repositoryPath: string
  ): Promise<StorageObjectVersion | null>;
  markPublished(input: { publicationId: string }): Promise<void>;
  recordObject(input: {
    object: StorageObjectVersion;
    publicationId: string;
    repositoryPath: string;
  }): Promise<void>;
  requireReservedPublication(input: {
    metadataVersion: number;
    publicationId: string;
    repositoryId: string;
  }): Promise<void>;
}

type TufStorageWriteInput = {
  body: Uint8Array | string;
  contentType: string;
  idempotencyKey: string;
  objectKey: string;
  ownerId: string;
  ownerKind: 'maintenance';
  storageRole: 'metadata';
};

export interface TufPublicationStoragePort {
  putImmutable(input: TufStorageWriteInput): Promise<StorageObjectVersion>;
  putVersioned(input: TufStorageWriteInput): Promise<StorageObjectVersion>;
}

type PublicationEntry = {
  body: Uint8Array;
  contentType: string;
  repositoryPath: string;
  replaceable: boolean;
};

function requireSafePath(value: string, name: string): string {
  if (value.includes('\\') || value.startsWith('/') || value.endsWith('/')) {
    throw new Error(`${name} is invalid`);
  }
  const segments = value.split('/');
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment === '.' || segment === '..' || !SAFE_PATH_SEGMENT.test(segment)
    )
  ) {
    throw new Error(`${name} is invalid`);
  }
  return segments.join('/');
}

function requireMetadataRole(
  file: VerifiedTufRepositoryFile,
  role: 'root' | 'snapshot' | 'targets' | 'timestamp',
  expectedVersion: number
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.body));
  } catch {
    throw new Error(`TUF ${role} metadata is not valid UTF-8 JSON`);
  }
  const signed =
    parsed && typeof parsed === 'object' && 'signed' in parsed
      ? (parsed as { signed?: unknown }).signed
      : null;
  if (
    !signed ||
    typeof signed !== 'object' ||
    (signed as { _type?: unknown })._type !== role ||
    (signed as { version?: unknown }).version !== expectedVersion
  ) {
    throw new Error(`TUF ${role} metadata does not match the reserved publication`);
  }
}

function publicationEntries(bundle: VerifiedTufRepositoryBundle): PublicationEntry[] {
  if (!REPOSITORY_ID_PATTERN.test(bundle.repositoryId)) {
    throw new Error('TUF repository identifier is invalid');
  }
  if (!Number.isSafeInteger(bundle.metadataVersion) || bundle.metadataVersion < 1) {
    throw new Error('TUF metadata version is invalid');
  }
  if (
    Number.isNaN(bundle.verifiedAt.getTime()) ||
    bundle.verifiedAt.getTime() > Date.now() + 60_000
  ) {
    throw new Error('TUF bundle verification time is invalid');
  }
  if (!ROOT_PATH_PATTERN.test(bundle.root.path)) {
    throw new Error('TUF root metadata path is invalid');
  }
  if (bundle.targets.path !== `${bundle.metadataVersion}.targets.json`) {
    throw new Error('TUF targets metadata path does not match its version');
  }
  if (bundle.snapshot.path !== `${bundle.metadataVersion}.snapshot.json`) {
    throw new Error('TUF snapshot metadata path does not match its version');
  }
  if (bundle.timestamp.path !== 'timestamp.json') {
    throw new Error('TUF timestamp metadata path is invalid');
  }
  const rootVersion = Number.parseInt(bundle.root.path.slice(0, -'.root.json'.length), 10);
  requireMetadataRole(bundle.root, 'root', rootVersion);
  requireMetadataRole(bundle.targets, 'targets', bundle.metadataVersion);
  requireMetadataRole(bundle.snapshot, 'snapshot', bundle.metadataVersion);
  requireMetadataRole(bundle.timestamp, 'timestamp', bundle.metadataVersion);

  const targetEntries = bundle.targetFiles
    .map((target) => ({
      body: target.body,
      contentType: target.contentType,
      repositoryPath: `targets/${requireSafePath(target.path, 'TUF target path')}`,
      replaceable: false,
    }))
    .sort((left, right) => left.repositoryPath.localeCompare(right.repositoryPath));
  const entries: PublicationEntry[] = [
    ...targetEntries,
    {
      body: bundle.root.body,
      contentType: 'application/json',
      repositoryPath: `metadata/${bundle.root.path}`,
      replaceable: false,
    },
    {
      body: bundle.targets.body,
      contentType: 'application/json',
      repositoryPath: `metadata/${bundle.targets.path}`,
      replaceable: false,
    },
    {
      body: bundle.snapshot.body,
      contentType: 'application/json',
      repositoryPath: `metadata/${bundle.snapshot.path}`,
      replaceable: false,
    },
    {
      body: bundle.timestamp.body,
      contentType: 'application/json',
      repositoryPath: 'metadata/timestamp.json',
      replaceable: true,
    },
  ];
  const uniquePaths = new Set(entries.map((entry) => entry.repositoryPath));
  if (uniquePaths.size !== entries.length) {
    throw new Error('TUF bundle contains a duplicate repository path');
  }
  return entries;
}

function requireRecordedObject(
  object: StorageObjectVersion,
  objectKey: string
): StorageObjectVersion {
  if (
    object.storageRole !== 'metadata' ||
    object.objectKey !== objectKey ||
    object.verificationState !== 'VERIFIED' ||
    !object.providerVersion ||
    !object.fileIdentifier
  ) {
    throw new Error('Recorded TUF object does not match the publication');
  }
  return object;
}

export async function publishTufRepository(input: {
  bundle: VerifiedTufRepositoryBundle;
  catalog: TufPublicationCatalogPort;
  publicationId: string;
  storage: TufPublicationStoragePort;
}): Promise<void> {
  await input.catalog.requireReservedPublication({
    metadataVersion: input.bundle.metadataVersion,
    publicationId: input.publicationId,
    repositoryId: input.bundle.repositoryId,
  });
  const entries = publicationEntries(input.bundle);
  for (const entry of entries) {
    const objectKey = `v2/metadata/tuf/${input.bundle.repositoryId}/${entry.repositoryPath}`;
    const recorded = await input.catalog.getRecordedObject(
      input.publicationId,
      entry.repositoryPath
    );
    if (recorded) {
      requireRecordedObject(recorded, objectKey);
      continue;
    }
    const write = entry.replaceable ? input.storage.putVersioned : input.storage.putImmutable;
    const object = await write.call(input.storage, {
      body: entry.body,
      contentType: entry.contentType,
      idempotencyKey: `tuf:${input.publicationId}:${entry.repositoryPath}`,
      objectKey,
      ownerId: input.publicationId,
      ownerKind: 'maintenance',
      storageRole: 'metadata',
    });
    await input.catalog.recordObject({
      object: requireRecordedObject(object, objectKey),
      publicationId: input.publicationId,
      repositoryPath: entry.repositoryPath,
    });
  }
  await input.catalog.markPublished({ publicationId: input.publicationId });
}
