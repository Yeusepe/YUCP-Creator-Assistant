import { createHash } from 'node:crypto';
import type { StorageObjectVersion } from '../catalog/exactStorageCatalog';
import type { ExactObjectHead } from './exactStorage';

const REPOSITORY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

export interface TufPublishedObjectCatalogPort {
  getPublishedObject(
    repositoryId: string,
    repositoryPath: string
  ): Promise<StorageObjectVersion | null>;
}

export interface TufRepositoryReadStoragePort {
  bucketName(role: 'metadata'): string;
  getExactVersion(input: {
    objectKey: string;
    providerVersion: string;
    role: 'metadata';
  }): Promise<Response>;
  headExactVersion(input: {
    objectKey: string;
    providerVersion: string;
    role: 'metadata';
  }): Promise<ExactObjectHead>;
}

function requireRepositoryId(value: string): string {
  if (!REPOSITORY_ID_PATTERN.test(value)) {
    throw new Error('TUF repository identifier is invalid');
  }
  return value;
}

function requireSafePath(value: string): string {
  const segments = value.split('/');
  if (
    value.includes('\\') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    segments.length === 0 ||
    segments.some(
      (segment) => segment === '.' || segment === '..' || !SAFE_PATH_SEGMENT.test(segment)
    )
  ) {
    throw new Error('TUF repository path is invalid');
  }
  return segments.join('/');
}

function verifyHead(object: StorageObjectVersion, head: ExactObjectHead): void {
  if (
    head.bucketName !== object.bucketName ||
    head.contentLength !== object.bytes ||
    head.contentType !== object.contentType ||
    head.fileIdentifier !== object.fileIdentifier ||
    head.metadata['yucp-sha256'] !== object.sha256 ||
    head.objectKey !== object.objectKey ||
    head.providerVersion !== object.providerVersion ||
    head.storageRole !== 'metadata'
  ) {
    throw new Error('Published TUF exact object head failed verification');
  }
}

export class ExactTufRepositoryReader {
  readonly #catalog: TufPublishedObjectCatalogPort;
  readonly #repositoryId: string;
  readonly #storage: TufRepositoryReadStoragePort;

  constructor(input: {
    catalog: TufPublishedObjectCatalogPort;
    repositoryId: string;
    storage: TufRepositoryReadStoragePort;
  }) {
    this.#catalog = input.catalog;
    this.#repositoryId = requireRepositoryId(input.repositoryId);
    this.#storage = input.storage;
  }

  async read(
    role: 'metadata' | 'targets',
    repositoryPath: string
  ): Promise<{ body: Uint8Array; contentType: string } | null> {
    const path = `${role}/${requireSafePath(repositoryPath)}`;
    const object = await this.#catalog.getPublishedObject(this.#repositoryId, path);
    if (!object) {
      return null;
    }
    const expectedKey = `v2/metadata/tuf/${this.#repositoryId}/${path}`;
    if (
      object.bucketName !== this.#storage.bucketName('metadata') ||
      object.objectKey !== expectedKey ||
      object.storageRole !== 'metadata' ||
      object.verificationState !== 'VERIFIED'
    ) {
      throw new Error('Published TUF object binding is invalid');
    }
    verifyHead(
      object,
      await this.#storage.headExactVersion({
        objectKey: object.objectKey,
        providerVersion: object.providerVersion,
        role: 'metadata',
      })
    );
    const response = await this.#storage.getExactVersion({
      objectKey: object.objectKey,
      providerVersion: object.providerVersion,
      role: 'metadata',
    });
    if (!response.ok) {
      throw new Error('Published TUF exact object read failed');
    }
    const body = new Uint8Array(await response.arrayBuffer());
    if (
      body.byteLength !== object.bytes ||
      createHash('sha256').update(body).digest('hex') !== object.sha256
    ) {
      throw new Error('Published TUF exact object body failed verification');
    }
    return {
      body,
      contentType: object.contentType,
    };
  }
}
