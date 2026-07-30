import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';
import { createS3Bucket, listS3ObjectPage } from '../storage-core/s3Control';
import {
  createStorageRoleCredential,
  type DisposableStorageHarness,
  loadStorageRoleConfig,
  MINIO_IMAGE,
  POSTGRES_17_IMAGE,
  publishedStoragePort,
  requireStorageDocker,
  runStorageDocker,
  STORAGE_ROLES,
  type StorageRole,
} from './disposableStorageHarness';
import { waitForMinioReady } from './minioReadiness';
import { waitForPostgres } from './postgresReadiness';

const PROFILE_VERSION = 2;
const OWNER_LABEL = 'club.yucp.storage-owner';
const OWNER_VALUE = 'interactive-dev';
const EPOCH_LABEL = 'club.yucp.storage-epoch';
const DEFAULT_PROFILE_ROOT = join(process.cwd(), '.volumes', 'package-storage-dev');

type StableCredential = {
  accessKeyId: string;
  secretAccessKey: string;
};

export type InteractiveDevSecrets = {
  couplingServiceSharedSecret: string;
  installSigningPrivateKey: string;
  materializationApiSharedSecret: string;
  materializationCapabilityPrivateKey: string;
  materializationKeyBrokerSharedSecret: string;
  materializationMaterializerSharedSecret: string;
  materializationRenditionSharedSecret: string;
  materializationReceiptPrivateKey: string;
  materializationSourceGrantPrivateKey: string;
  packageCatalogControlSharedSecret: string;
  uploadHmacKey: string;
};

type InteractiveStorageProfile = {
  bucketNames: Record<StorageRole, string>;
  databaseName: string;
  databasePassword: string;
  epoch: string;
  minioRoot: StableCredential;
  profileVersion: number;
  roleCredentials: Record<StorageRole, StableCredential>;
  runtimeSecrets: InteractiveDevSecrets;
};

export interface InteractiveStorageHarness extends DisposableStorageHarness {
  persistent: true;
  runtimeSecrets: InteractiveDevSecrets;
}

export type StartInteractiveStorageHarnessOptions = {
  profileRoot?: string;
};

export type ResetInteractiveStorageHarnessOptions = {
  expectedEpoch: string;
  profileRoot?: string;
};

function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function makeProfile(): InteractiveStorageProfile {
  const epoch = randomBytes(6).toString('hex');
  return {
    bucketNames: Object.fromEntries(
      STORAGE_ROLES.map((role) => [role, `yucp-dev-${epoch}-${role}`])
    ) as Record<StorageRole, string>,
    databaseName: `yucp_storage_dev_${epoch}`,
    databasePassword: randomSecret(24),
    epoch,
    minioRoot: {
      accessKeyId: `yucp-root-${randomBytes(5).toString('hex')}`,
      secretAccessKey: randomSecret(24),
    },
    profileVersion: PROFILE_VERSION,
    roleCredentials: Object.fromEntries(
      STORAGE_ROLES.map((role) => [
        role,
        {
          accessKeyId: `yucp-${role.slice(0, 1)}-${randomBytes(6).toString('hex')}`,
          secretAccessKey: randomHex(20),
        },
      ])
    ) as Record<StorageRole, StableCredential>,
    runtimeSecrets: {
      couplingServiceSharedSecret: randomSecret(),
      installSigningPrivateKey: randomSecret(),
      materializationApiSharedSecret: randomSecret(),
      materializationCapabilityPrivateKey: randomSecret(),
      materializationKeyBrokerSharedSecret: randomSecret(),
      materializationMaterializerSharedSecret: randomSecret(),
      materializationRenditionSharedSecret: randomSecret(),
      materializationReceiptPrivateKey: randomSecret(),
      materializationSourceGrantPrivateKey: randomSecret(),
      packageCatalogControlSharedSecret: randomSecret(),
      uploadHmacKey: randomSecret(),
    },
  };
}

function requireNonemptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Interactive storage profile field ${field} is invalid`);
  }
  return value;
}

function parseCredential(value: unknown, field: string): StableCredential {
  if (!value || typeof value !== 'object') {
    throw new Error(`Interactive storage profile field ${field} is invalid`);
  }
  const record = value as Record<string, unknown>;
  return {
    accessKeyId: requireNonemptyString(record.accessKeyId, `${field}.accessKeyId`),
    secretAccessKey: requireNonemptyString(record.secretAccessKey, `${field}.secretAccessKey`),
  };
}

function parseProfile(value: unknown): InteractiveStorageProfile {
  if (!value || typeof value !== 'object') {
    throw new Error('Interactive storage profile is invalid');
  }
  const record = value as Record<string, unknown>;
  if (record.profileVersion !== PROFILE_VERSION) {
    throw new Error('Interactive storage profile version is unsupported');
  }
  if (!record.bucketNames || typeof record.bucketNames !== 'object') {
    throw new Error('Interactive storage bucket names are invalid');
  }
  if (!record.roleCredentials || typeof record.roleCredentials !== 'object') {
    throw new Error('Interactive storage role credentials are invalid');
  }
  if (!record.runtimeSecrets || typeof record.runtimeSecrets !== 'object') {
    throw new Error('Interactive development secrets are invalid');
  }
  const bucketRecord = record.bucketNames as Record<string, unknown>;
  const credentialRecord = record.roleCredentials as Record<string, unknown>;
  const secretRecord = record.runtimeSecrets as Record<string, unknown>;
  const runtimeSecrets = Object.fromEntries(
    [
      'couplingServiceSharedSecret',
      'installSigningPrivateKey',
      'materializationApiSharedSecret',
      'materializationCapabilityPrivateKey',
      'materializationKeyBrokerSharedSecret',
      'materializationMaterializerSharedSecret',
      'materializationRenditionSharedSecret',
      'materializationReceiptPrivateKey',
      'materializationSourceGrantPrivateKey',
      'packageCatalogControlSharedSecret',
      'uploadHmacKey',
    ].map((field) => [field, requireNonemptyString(secretRecord[field], `runtimeSecrets.${field}`)])
  ) as InteractiveDevSecrets;
  return {
    bucketNames: Object.fromEntries(
      STORAGE_ROLES.map((role) => [
        role,
        requireNonemptyString(bucketRecord[role], `bucketNames.${role}`),
      ])
    ) as Record<StorageRole, string>,
    databaseName: requireNonemptyString(record.databaseName, 'databaseName'),
    databasePassword: requireNonemptyString(record.databasePassword, 'databasePassword'),
    epoch: requireNonemptyString(record.epoch, 'epoch'),
    minioRoot: parseCredential(record.minioRoot, 'minioRoot'),
    profileVersion: PROFILE_VERSION,
    roleCredentials: Object.fromEntries(
      STORAGE_ROLES.map((role) => [
        role,
        parseCredential(credentialRecord[role], `roleCredentials.${role}`),
      ])
    ) as Record<StorageRole, StableCredential>,
    runtimeSecrets,
  };
}

async function writeProfile(
  profileRoot: string,
  profile: InteractiveStorageProfile
): Promise<void> {
  await mkdir(profileRoot, { recursive: true });
  const profilePath = join(profileRoot, 'profile.json');
  const temporaryPath = join(profileRoot, `profile.${process.pid}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, profilePath);
  if (process.platform !== 'win32') {
    await chmod(profilePath, 0o600);
  }
}

async function loadOrCreateProfile(profileRoot: string): Promise<InteractiveStorageProfile> {
  try {
    return parseProfile(JSON.parse(await readFile(join(profileRoot, 'profile.json'), 'utf8')));
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      const profile = makeProfile();
      await writeProfile(profileRoot, profile);
      return profile;
    }
    throw error;
  }
}

function resourceNames(epoch: string): {
  minioContainer: string;
  minioVolume: string;
  postgresContainer: string;
  postgresVolume: string;
} {
  return {
    minioContainer: `yucp-storage-dev-s3-${epoch}`,
    minioVolume: `yucp-storage-dev-s3-data-${epoch}`,
    postgresContainer: `yucp-storage-dev-pg-${epoch}`,
    postgresVolume: `yucp-storage-dev-pg-data-${epoch}`,
  };
}

async function requireContainerAbsent(containerName: string): Promise<void> {
  const result = await runStorageDocker(['container', 'inspect', containerName]);
  if (result.exitCode === 0) {
    throw new Error(
      `Interactive storage container ${containerName} already exists. Stop the active dev runtime first.`
    );
  }
}

async function createOwnedVolume(volumeName: string, epoch: string): Promise<void> {
  await requireStorageDocker('Interactive storage volume creation', [
    'volume',
    'create',
    '--label',
    `${OWNER_LABEL}=${OWNER_VALUE}`,
    '--label',
    `${EPOCH_LABEL}=${epoch}`,
    volumeName,
  ]);
}

async function bucketExists(config: ReturnType<typeof loadStorageRoleConfig>): Promise<boolean> {
  try {
    await listS3ObjectPage(config, { maxKeys: 1, prefix: '' });
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('HTTP status 404')) {
      return false;
    }
    throw error;
  }
}

async function removeOwnedContainer(containerName: string, epoch: string): Promise<void> {
  const inspection = await runStorageDocker([
    'container',
    'inspect',
    '--format',
    `{{ index .Config.Labels "${EPOCH_LABEL}" }}`,
    containerName,
  ]);
  if (inspection.exitCode !== 0) {
    if (inspection.stderr.toLowerCase().includes('no such')) {
      return;
    }
    throw new Error(`Interactive storage container inspection failed\n${inspection.stderr}`);
  }
  if (inspection.stdout.trim() !== epoch) {
    throw new Error('Refusing to remove an interactive storage container from another epoch');
  }
  await requireStorageDocker('Interactive storage container stop', [
    'rm',
    '--force',
    containerName,
  ]);
}

async function removeOwnedVolume(volumeName: string, epoch: string): Promise<void> {
  const inspection = await runStorageDocker([
    'volume',
    'inspect',
    '--format',
    `{{ index .Labels "${EPOCH_LABEL}" }}`,
    volumeName,
  ]);
  if (inspection.exitCode !== 0) {
    if (inspection.stderr.toLowerCase().includes('no such')) {
      return;
    }
    throw new Error(`Interactive storage volume inspection failed\n${inspection.stderr}`);
  }
  if (inspection.stdout.trim() !== epoch) {
    throw new Error('Refusing to remove an interactive storage volume from another epoch');
  }
  await requireStorageDocker('Interactive storage volume removal', ['volume', 'rm', volumeName]);
}

export async function startInteractiveStorageHarness(
  options: StartInteractiveStorageHarnessOptions = {}
): Promise<InteractiveStorageHarness> {
  const profileRoot = resolve(options.profileRoot ?? DEFAULT_PROFILE_ROOT);
  const profile = await loadOrCreateProfile(profileRoot);
  const names = resourceNames(profile.epoch);
  const pipelineScratchRoot = join(profileRoot, 'pipeline-scratch');
  const uploadDir = join(profileRoot, 'uploads');
  await Promise.all([
    mkdir(pipelineScratchRoot, { recursive: true }),
    mkdir(uploadDir, { recursive: true }),
  ]);
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    const results = await Promise.allSettled([
      removeOwnedContainer(names.minioContainer, profile.epoch),
      removeOwnedContainer(names.postgresContainer, profile.epoch),
    ]);
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Interactive storage shutdown failed');
    }
  };

  try {
    await requireStorageDocker('Docker availability check', ['version']);
    await Promise.all([
      requireContainerAbsent(names.postgresContainer),
      requireContainerAbsent(names.minioContainer),
    ]);
    await Promise.all([
      createOwnedVolume(names.postgresVolume, profile.epoch),
      createOwnedVolume(names.minioVolume, profile.epoch),
    ]);
    await requireStorageDocker(
      'Interactive PostgreSQL container startup',
      [
        'run',
        '--detach',
        '--rm',
        '--name',
        names.postgresContainer,
        '--label',
        `${OWNER_LABEL}=${OWNER_VALUE}`,
        '--label',
        `${EPOCH_LABEL}=${profile.epoch}`,
        '--env',
        'POSTGRES_PASSWORD',
        '--env',
        `POSTGRES_DB=${profile.databaseName}`,
        '--publish',
        '127.0.0.1::5432',
        '--volume',
        `${names.postgresVolume}:/var/lib/postgresql/data`,
        POSTGRES_17_IMAGE,
      ],
      {
        env: { POSTGRES_PASSWORD: profile.databasePassword },
        redact: [profile.databasePassword],
      }
    );
    await requireStorageDocker(
      'Interactive MinIO container startup',
      [
        'run',
        '--detach',
        '--rm',
        '--name',
        names.minioContainer,
        '--label',
        `${OWNER_LABEL}=${OWNER_VALUE}`,
        '--label',
        `${EPOCH_LABEL}=${profile.epoch}`,
        '--env',
        'MINIO_ROOT_USER',
        '--env',
        'MINIO_ROOT_PASSWORD',
        '--publish',
        '127.0.0.1::9000',
        '--volume',
        `${names.minioVolume}:/data`,
        MINIO_IMAGE,
        'server',
        '/data',
        '--address',
        ':9000',
      ],
      {
        env: {
          MINIO_ROOT_PASSWORD: profile.minioRoot.secretAccessKey,
          MINIO_ROOT_USER: profile.minioRoot.accessKeyId,
        },
        redact: [profile.minioRoot.accessKeyId, profile.minioRoot.secretAccessKey],
      }
    );

    await waitForPostgres({
      containerName: names.postgresContainer,
      databaseName: profile.databaseName,
      runDocker: runStorageDocker,
    });
    const [postgresPort, minioPort] = await Promise.all([
      publishedStoragePort(names.postgresContainer, '5432'),
      publishedStoragePort(names.minioContainer, '9000'),
    ]);
    const endpoint = `http://127.0.0.1:${minioPort}`;
    await waitForMinioReady({ endpoint });
    await requireStorageDocker('Interactive MinIO client configuration', [
      'exec',
      names.minioContainer,
      '/bin/sh',
      '-ceu',
      'mc alias set -- local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"',
    ]);

    const buckets = {} as InteractiveStorageHarness['buckets'];
    for (const role of STORAGE_ROLES) {
      const rootConfig = loadStorageRoleConfig({
        accessKeyId: profile.minioRoot.accessKeyId,
        bucket: profile.bucketNames[role],
        endpoint,
        secretAccessKey: profile.minioRoot.secretAccessKey,
      });
      if (!(await bucketExists(rootConfig))) {
        await createS3Bucket(rootConfig);
      }
      const credential = await createStorageRoleCredential({
        bucket: profile.bucketNames[role],
        containerName: names.minioContainer,
        credential: profile.roleCredentials[role],
        policyFile: join(profileRoot, `${role}-policy.json`),
        policyName: `yucp-dev-${role}-${profile.epoch}`,
        role,
        runId: profile.epoch,
      });
      buckets[role] = loadStorageRoleConfig({
        ...credential,
        bucket: profile.bucketNames[role],
        endpoint,
      });
    }

    return {
      buckets,
      minio: {
        containerName: names.minioContainer,
        endpoint,
      },
      persistent: true,
      postgres: {
        containerName: names.postgresContainer,
        databaseName: profile.databaseName,
        url: `postgres://postgres:${profile.databasePassword}@127.0.0.1:${postgresPort}/${profile.databaseName}`,
      },
      runId: profile.epoch,
      runtimeSecrets: profile.runtimeSecrets,
      scratchRoot: pipelineScratchRoot,
      stop,
      uploadDir,
    };
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Interactive storage startup and container cleanup failed'
      );
    }
    throw error;
  }
}

export async function resetInteractiveStorageHarness(
  options: ResetInteractiveStorageHarnessOptions
): Promise<void> {
  const profileRoot = resolve(options.profileRoot ?? DEFAULT_PROFILE_ROOT);
  const parsedRoot = parse(profileRoot);
  if (profileRoot === parsedRoot.root || profileRoot === resolve(process.cwd())) {
    throw new Error('Refusing to reset a broad interactive storage path');
  }
  const profile = parseProfile(
    JSON.parse(await readFile(join(profileRoot, 'profile.json'), 'utf8'))
  );
  if (profile.epoch !== options.expectedEpoch) {
    throw new Error('Interactive storage reset epoch confirmation does not match');
  }
  const names = resourceNames(profile.epoch);
  await Promise.all([
    removeOwnedContainer(names.minioContainer, profile.epoch),
    removeOwnedContainer(names.postgresContainer, profile.epoch),
  ]);
  await Promise.all([
    removeOwnedVolume(names.minioVolume, profile.epoch),
    removeOwnedVolume(names.postgresVolume, profile.epoch),
  ]);
  await rm(profileRoot, { force: true, recursive: true });
}

export function interactiveStorageProfileRoot(): string {
  return DEFAULT_PROFILE_ROOT;
}
