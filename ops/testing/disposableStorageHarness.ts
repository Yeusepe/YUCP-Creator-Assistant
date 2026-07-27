import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { type CasConfig, loadCasConfig } from '../storage-core/config';
import { createS3Bucket } from '../storage-core/s3Control';
import { waitForMinioReady } from './minioReadiness';
import { waitForPostgres } from './postgresReadiness';

export const POSTGRES_17_IMAGE =
  'postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193';
export const MINIO_IMAGE =
  'minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e';

export const STORAGE_ROLES = [
  'quarantine',
  'common',
  'protected',
  'metadata',
  'renditions',
] as const;

export type StorageRole = (typeof STORAGE_ROLES)[number];

export const OBJECT_LOCK_ROLES = new Set<StorageRole>(['common', 'protected', 'metadata']);
const ROLE_CODES: Record<StorageRole, string> = {
  quarantine: 'q',
  common: 'c',
  protected: 'p',
  metadata: 'm',
  renditions: 'r',
};

export interface DockerCommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface RunDockerOptions {
  env?: Record<string, string>;
  redact?: readonly string[];
}

export interface DisposableStorageHarness {
  buckets: Record<StorageRole, CasConfig>;
  minio: {
    containerName: string;
    endpoint: string;
  };
  postgres: {
    containerName: string;
    databaseName: string;
    url: string;
  };
  runId: string;
  scratchRoot: string;
  stop: () => Promise<void>;
  uploadDir: string;
}

function redact(value: string, sensitiveValues: readonly string[] = []): string {
  return sensitiveValues.reduce(
    (result, sensitiveValue) =>
      sensitiveValue ? result.replaceAll(sensitiveValue, '[REDACTED]') : result,
    value
  );
}

export async function runStorageDocker(
  args: string[],
  options: RunDockerOptions = {}
): Promise<DockerCommandResult> {
  const child = Bun.spawn(['docker', ...args], {
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {
    exitCode,
    stderr: redact(stderr.trim(), options.redact),
    stdout: redact(stdout.trim(), options.redact),
  };
}

export async function requireStorageDocker(
  operation: string,
  args: string[],
  options?: RunDockerOptions
): Promise<string> {
  const result = await runStorageDocker(args, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `${operation} failed with exit code ${result.exitCode}\n${result.stderr || result.stdout}`
    );
  }
  return result.stdout;
}

export async function publishedStoragePort(
  containerName: string,
  containerPort: string
): Promise<string> {
  const output = await requireStorageDocker('Docker port inspection', [
    'port',
    containerName,
    `${containerPort}/tcp`,
  ]);
  const port = output.match(/:(\d+)\s*$/m)?.[1];
  if (!port) {
    throw new Error(`Docker returned no published port for ${containerName}`);
  }
  return port;
}

function assertDisposablePath(path: string): void {
  const relativePath = relative(resolve(tmpdir()), resolve(path));
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error('Refusing to clean a storage harness path outside the system temporary folder');
  }
}

function rolePolicy(bucket: string): object {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: [
          's3:GetBucketLocation',
          's3:GetBucketObjectLockConfiguration',
          's3:GetBucketVersioning',
          's3:ListBucket',
          's3:ListBucketMultipartUploads',
          's3:ListBucketVersions',
        ],
        Resource: [`arn:aws:s3:::${bucket}`],
      },
      {
        Effect: 'Allow',
        Action: [
          's3:AbortMultipartUpload',
          's3:DeleteObject',
          's3:DeleteObjectVersion',
          's3:GetObject',
          's3:GetObjectRetention',
          's3:GetObjectVersion',
          's3:ListMultipartUploadParts',
          's3:PutObject',
          's3:PutObjectRetention',
        ],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      },
    ],
  };
}

export function loadStorageRoleConfig(input: {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  secretAccessKey: string;
}): CasConfig {
  return loadCasConfig({
    CAS_S3_ACCESS_KEY_ID: input.accessKeyId,
    CAS_S3_BUCKET: input.bucket,
    CAS_S3_ENDPOINT: input.endpoint,
    CAS_S3_REGION: 'us-east-1',
    CAS_S3_SECRET_ACCESS_KEY: input.secretAccessKey,
  });
}

/**
 * Create MinIO users with the official bundled mc client.
 *
 * User reference: https://docs.min.io/aistor/reference/cli/admin/mc-admin-user/mc-admin-user-add/
 * Policy reference:
 * https://docs.min.io/aistor/reference/cli/admin/mc-admin-policy/mc-admin-policy-create/
 * Attachment reference:
 * https://docs.min.io/aistor/reference/cli/admin/mc-admin-policy/mc-admin-policy-attach/
 */
export async function createStorageRoleCredential(input: {
  bucket: string;
  containerName: string;
  credential?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
  policyFile: string;
  policyName?: string;
  role: StorageRole;
  runId: string;
}): Promise<{ accessKeyId: string; secretAccessKey: string }> {
  const accessKeyId =
    input.credential?.accessKeyId ??
    `yucp-${ROLE_CODES[input.role]}-${randomBytes(6).toString('hex')}`;
  const secretAccessKey = input.credential?.secretAccessKey ?? randomBytes(20).toString('hex');
  const policyName = input.policyName ?? `yucp-${input.role}-${input.runId}`;
  const containerPolicyFile = `/tmp/${policyName}.json`;
  await writeFile(input.policyFile, `${JSON.stringify(rolePolicy(input.bucket), null, 2)}\n`);
  await requireStorageDocker('MinIO policy copy', [
    'cp',
    input.policyFile,
    `${input.containerName}:${containerPolicyFile}`,
  ]);
  await requireStorageDocker('MinIO policy creation', [
    'exec',
    input.containerName,
    'mc',
    'admin',
    'policy',
    'create',
    'local',
    policyName,
    containerPolicyFile,
  ]);
  const roleEnvironment = {
    YUCP_ROLE_ACCESS_KEY: accessKeyId,
    YUCP_ROLE_SECRET_KEY: secretAccessKey,
  };
  const redactions = [accessKeyId, secretAccessKey];
  const existingUser = await runStorageDocker(
    [
      'exec',
      '--env',
      'YUCP_ROLE_ACCESS_KEY',
      input.containerName,
      '/bin/sh',
      '-ceu',
      'mc admin user info local "$YUCP_ROLE_ACCESS_KEY"',
    ],
    { env: roleEnvironment, redact: redactions }
  );
  if (existingUser.exitCode !== 0) {
    await requireStorageDocker(
      'MinIO user creation',
      [
        'exec',
        '--env',
        'YUCP_ROLE_ACCESS_KEY',
        '--env',
        'YUCP_ROLE_SECRET_KEY',
        input.containerName,
        '/bin/sh',
        '-ceu',
        'mc admin user add local "$YUCP_ROLE_ACCESS_KEY" "$YUCP_ROLE_SECRET_KEY"',
      ],
      { env: roleEnvironment, redact: redactions }
    );
  }
  await requireStorageDocker(
    'MinIO policy attachment',
    [
      'exec',
      '--env',
      'YUCP_ROLE_ACCESS_KEY',
      input.containerName,
      '/bin/sh',
      '-ceu',
      `mc admin policy attach local ${policyName} --user "$YUCP_ROLE_ACCESS_KEY"`,
    ],
    { env: roleEnvironment, redact: redactions }
  );
  return { accessKeyId, secretAccessKey };
}

export async function startDisposableStorageHarness(): Promise<DisposableStorageHarness> {
  const runId = randomBytes(6).toString('hex');
  const postgresContainerName = `yucp-storage-pg-${runId}`;
  const minioContainerName = `yucp-storage-s3-${runId}`;
  const databaseName = `yucp_storage_${runId}`;
  const databasePassword = randomBytes(24).toString('base64url');
  const rootAccessKey = `yucp-root-${randomBytes(5).toString('hex')}`;
  const rootSecretKey = randomBytes(24).toString('base64url');
  const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-storage-harness-'));
  const pipelineScratchRoot = join(scratchPath, 'pipeline-scratch');
  const uploadDir = join(scratchPath, 'uploads');
  await Promise.all([mkdir(pipelineScratchRoot), mkdir(uploadDir)]);
  const startedContainers: string[] = [];
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    const failures: string[] = [];
    for (const containerName of startedContainers.reverse()) {
      const result = await runStorageDocker(['rm', '--force', containerName]);
      if (result.exitCode !== 0 && !result.stderr.includes('No such container')) {
        failures.push(`${containerName}: ${result.stderr || result.stdout}`);
      }
    }
    startedContainers.length = 0;
    try {
      assertDisposablePath(scratchPath);
      await rm(scratchPath, { force: true, recursive: true });
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    if (failures.length > 0) {
      throw new Error(`Storage harness cleanup failed\n${failures.join('\n')}`);
    }
  };

  try {
    await requireStorageDocker('Docker availability check', ['version']);
    await requireStorageDocker(
      'PostgreSQL container startup',
      [
        'run',
        '--detach',
        '--rm',
        '--name',
        postgresContainerName,
        '--env',
        'POSTGRES_PASSWORD',
        '--env',
        `POSTGRES_DB=${databaseName}`,
        '--publish',
        '127.0.0.1::5432',
        '--tmpfs',
        '/var/lib/postgresql/data',
        POSTGRES_17_IMAGE,
      ],
      {
        env: { POSTGRES_PASSWORD: databasePassword },
        redact: [databasePassword],
      }
    );
    startedContainers.push(postgresContainerName);

    await requireStorageDocker(
      'MinIO container startup',
      [
        'run',
        '--detach',
        '--rm',
        '--name',
        minioContainerName,
        '--env',
        'MINIO_ROOT_USER',
        '--env',
        'MINIO_ROOT_PASSWORD',
        '--publish',
        '127.0.0.1::9000',
        '--tmpfs',
        '/data',
        MINIO_IMAGE,
        'server',
        '/data',
        '--address',
        ':9000',
      ],
      {
        env: {
          MINIO_ROOT_PASSWORD: rootSecretKey,
          MINIO_ROOT_USER: rootAccessKey,
        },
        redact: [rootAccessKey, rootSecretKey],
      }
    );
    startedContainers.push(minioContainerName);

    await waitForPostgres({
      containerName: postgresContainerName,
      databaseName,
      runDocker: runStorageDocker,
    });
    const [postgresPort, minioPort] = await Promise.all([
      publishedStoragePort(postgresContainerName, '5432'),
      publishedStoragePort(minioContainerName, '9000'),
    ]);
    const endpoint = `http://127.0.0.1:${minioPort}`;
    await waitForMinioReady({ endpoint });
    await requireStorageDocker('MinIO client configuration', [
      'exec',
      minioContainerName,
      '/bin/sh',
      '-ceu',
      'mc alias set -- local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"',
    ]);

    const buckets = {} as Record<StorageRole, CasConfig>;
    for (const role of STORAGE_ROLES) {
      const bucket = `yucp-${runId}-${role}`;
      const rootConfig = loadStorageRoleConfig({
        accessKeyId: rootAccessKey,
        bucket,
        endpoint,
        secretAccessKey: rootSecretKey,
      });
      await createS3Bucket(rootConfig, { objectLockEnabled: OBJECT_LOCK_ROLES.has(role) });
      const credential = await createStorageRoleCredential({
        bucket,
        containerName: minioContainerName,
        policyFile: join(scratchPath, `${role}-policy.json`),
        role,
        runId,
      });
      buckets[role] = loadStorageRoleConfig({
        ...credential,
        bucket,
        endpoint,
      });
    }

    return {
      buckets,
      minio: {
        containerName: minioContainerName,
        endpoint,
      },
      postgres: {
        containerName: postgresContainerName,
        databaseName,
        url: `postgres://postgres:${databasePassword}@127.0.0.1:${postgresPort}/${databaseName}`,
      },
      runId,
      scratchRoot: pipelineScratchRoot,
      stop,
      uploadDir,
    };
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Storage harness startup and cleanup failed');
    }
    throw error;
  }
}
