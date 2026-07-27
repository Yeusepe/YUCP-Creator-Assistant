import { createHash } from 'node:crypto';
import type { CatalogDatabase } from '../../../../ops/catalog/database';
import { ExactStorageCatalog } from '../../../../ops/catalog/exactStorageCatalog';
import { loadStorageRoleConfig, STORAGE_ROLE_PREFIXES } from '../../../../ops/storage-core/config';
import { DurableExactStorage } from '../../../../ops/storage-core/durableExactStorage';
import {
  type ExactStoragePort,
  S3ExactStoragePort,
} from '../../../../ops/storage-core/exactStorage';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PACKAGE_ID_PATTERN = /^[a-z0-9][a-z0-9._/:~-]{0,127}$/;
const PUBLICATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const REQUIRED_STORAGE_KEYS = [
  'METADATA_S3_ACCESS_KEY_ID',
  'METADATA_S3_BUCKET',
  'METADATA_S3_ENDPOINT',
  'METADATA_S3_REGION',
  'METADATA_S3_SECRET_ACCESS_KEY',
] as const;

export type VpmAliasArtifactReference = {
  bucketName: string;
  byteSize: number;
  contentType: 'application/zip';
  objectKey: string;
  providerVersion: string;
  sha256: string;
};

type DurableMetadataWriter = Pick<DurableExactStorage, 'putImmutable'>;
type ExactMetadataReader = Pick<
  ExactStoragePort,
  'bucketName' | 'getExactVersion' | 'headExactVersion'
>;

export interface VpmAliasArtifactStore {
  readonly bucketName: string;
  publish(input: {
    body: Uint8Array;
    bootstrapVersion: string;
    packageId: string;
    publicationId: string;
    sha256: string;
  }): Promise<VpmAliasArtifactReference>;
  readExact(reference: VpmAliasArtifactReference): Promise<Uint8Array>;
}

function normalizeIndexPrefix(value: string): string {
  const normalized = value.replace(/^\/+|\/+$/g, '');
  return normalized ? `${normalized}/` : '';
}

export function createVpmAliasArtifactStore(input: {
  durableStorage: DurableMetadataWriter;
  exactStorage: ExactMetadataReader;
  indexPrefix: string;
}): VpmAliasArtifactStore {
  const indexPrefix = normalizeIndexPrefix(input.indexPrefix);
  return {
    bucketName: input.exactStorage.bucketName('metadata'),

    async publish(publication): Promise<VpmAliasArtifactReference> {
      if (
        !PACKAGE_ID_PATTERN.test(publication.packageId) ||
        !PUBLICATION_ID_PATTERN.test(publication.publicationId) ||
        !VERSION_PATTERN.test(publication.bootstrapVersion) ||
        !SHA256_PATTERN.test(publication.sha256)
      ) {
        throw new Error('VPM alias publication identity is invalid');
      }
      const body = Uint8Array.from(publication.body);
      const sha256 = createHash('sha256').update(body).digest('hex');
      if (sha256 !== publication.sha256) {
        throw new Error('VPM alias artifact digest does not match its bytes');
      }
      const packageDigest = createHash('sha256')
        .update(publication.packageId, 'utf8')
        .digest('hex');
      const objectKey = `${indexPrefix}vpm/aliases/${packageDigest}/${publication.publicationId.toLowerCase()}/${publication.bootstrapVersion}.zip`;
      const stored = await input.durableStorage.putImmutable({
        body,
        contentType: 'application/zip',
        idempotencyKey: `vpm-alias-publication:${publication.publicationId.toLowerCase()}:${sha256}`,
        objectKey,
        ownerId: publication.publicationId.toLowerCase(),
        ownerKind: 'vpm-alias-publication',
        storageRole: 'metadata',
      });
      if (
        stored.bucketName !== input.exactStorage.bucketName('metadata') ||
        stored.bytes !== body.byteLength ||
        stored.contentType !== 'application/zip' ||
        stored.objectKey !== objectKey ||
        stored.sha256 !== sha256 ||
        stored.storageRole !== 'metadata'
      ) {
        throw new Error('VPM alias exact artifact does not match its publication');
      }
      return {
        bucketName: stored.bucketName,
        byteSize: stored.bytes,
        contentType: 'application/zip',
        objectKey: stored.objectKey,
        providerVersion: stored.providerVersion,
        sha256: stored.sha256,
      };
    },

    async readExact(reference): Promise<Uint8Array> {
      if (
        reference.bucketName !== input.exactStorage.bucketName('metadata') ||
        !Number.isSafeInteger(reference.byteSize) ||
        reference.byteSize <= 0 ||
        !SHA256_PATTERN.test(reference.sha256) ||
        !reference.objectKey ||
        !reference.providerVersion
      ) {
        throw new Error('VPM alias exact artifact reference is invalid');
      }
      const head = await input.exactStorage.headExactVersion({
        objectKey: reference.objectKey,
        providerVersion: reference.providerVersion,
        role: 'metadata',
      });
      if (
        head.bucketName !== reference.bucketName ||
        head.contentLength !== reference.byteSize ||
        head.contentType !== reference.contentType ||
        head.metadata['yucp-sha256'] !== reference.sha256
      ) {
        throw new Error('VPM alias artifact exact version does not match its descriptor');
      }
      const response = await input.exactStorage.getExactVersion({
        objectKey: reference.objectKey,
        providerVersion: reference.providerVersion,
        role: 'metadata',
      });
      const body = new Uint8Array(await response.arrayBuffer());
      if (
        body.byteLength !== reference.byteSize ||
        createHash('sha256').update(body).digest('hex') !== reference.sha256
      ) {
        throw new Error('VPM alias artifact body failed verification');
      }
      return body;
    },
  };
}

export function createConfiguredVpmAliasArtifactStore(
  env: NodeJS.ProcessEnv,
  database: CatalogDatabase
): VpmAliasArtifactStore | undefined {
  if (!REQUIRED_STORAGE_KEYS.every((key) => env[key]?.trim())) {
    return undefined;
  }
  const config = loadStorageRoleConfig(env, STORAGE_ROLE_PREFIXES.metadata);
  const exactStorage = new S3ExactStoragePort({ metadata: config });
  return createVpmAliasArtifactStore({
    durableStorage: new DurableExactStorage(new ExactStorageCatalog(database), exactStorage),
    exactStorage,
    indexPrefix: config.indexPrefix,
  });
}
