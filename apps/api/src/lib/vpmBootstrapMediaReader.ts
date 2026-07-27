import { createHash } from 'node:crypto';
import { loadStorageRoleConfig, STORAGE_ROLE_PREFIXES } from '../../../../ops/storage-core/config';
import { S3ExactStoragePort } from '../../../../ops/storage-core/exactStorage';
import type { VpmBootstrapMediaReader } from '../routes/vpm';
import type { YucpAliasPackageMediaReference } from '../routes/vpmAliasPackage';

const REQUIRED_KEYS = [
  'METADATA_S3_ACCESS_KEY_ID',
  'METADATA_S3_BUCKET',
  'METADATA_S3_ENDPOINT',
  'METADATA_S3_REGION',
  'METADATA_S3_SECRET_ACCESS_KEY',
] as const;

type BootstrapMediaStoragePort = Pick<S3ExactStoragePort, 'getExactVersion' | 'headExactVersion'>;

export function createVpmBootstrapMediaReader(
  config: { bucket: string; indexPrefix: string },
  storage: BootstrapMediaStoragePort
): VpmBootstrapMediaReader {
  return {
    async readExact(reference: YucpAliasPackageMediaReference): Promise<Uint8Array> {
      const canonicalObjectKey = `${config.indexPrefix}bootstrap-media/${reference.sha256}.png`;
      if (reference.objectKey !== canonicalObjectKey) {
        throw new Error('Bootstrap media does not use its canonical bootstrap media key');
      }
      if (
        !reference.bucketName ||
        !reference.providerVersion ||
        reference.bucketName !== config.bucket
      ) {
        throw new Error('Bootstrap media has no valid exact metadata-storage reference');
      }
      const head = await storage.headExactVersion({
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
        throw new Error('Bootstrap media exact version does not match its descriptor');
      }
      const response = await storage.getExactVersion({
        objectKey: reference.objectKey,
        providerVersion: reference.providerVersion,
        role: 'metadata',
      });
      const body = new Uint8Array(await response.arrayBuffer());
      if (
        body.byteLength !== reference.byteSize ||
        createHash('sha256').update(body).digest('hex') !== reference.sha256
      ) {
        throw new Error('Bootstrap media body failed digest verification');
      }
      return body;
    },
  };
}

export function loadVpmBootstrapMediaReader(
  env: NodeJS.ProcessEnv
): VpmBootstrapMediaReader | undefined {
  if (!REQUIRED_KEYS.every((key) => env[key]?.trim())) {
    return undefined;
  }
  const config = loadStorageRoleConfig(env, STORAGE_ROLE_PREFIXES.metadata);
  const storage = new S3ExactStoragePort({ metadata: config });
  return createVpmBootstrapMediaReader(config, storage);
}
