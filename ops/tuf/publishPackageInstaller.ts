import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAX_PACKAGE_INSTALLER_HELPER_BYTES } from '@yucp/shared/packageInstallerLimits';
import {
  ExactStorageCatalog,
  openCatalogDatabase,
  runCatalogMigrations,
  TufRepositoryCatalog,
} from '../catalog';
import {
  hydrateStorageServiceEnv,
  loadStorageRoleConfig,
  STORAGE_ROLE_PREFIXES,
} from '../storage-core/config';
import { DurableExactStorage } from '../storage-core/durableExactStorage';
import { S3ExactStoragePort } from '../storage-core/exactStorage';
import {
  publishTufRepository,
  type VerifiedTufRepositoryBundle,
} from '../storage-core/tufRepositoryPublication';

const HELPER_TARGET = 'helper/windows-amd64/yucp-transfer-helper.exe';
const BROKER_TARGET = 'broker/windows-amd64/yucp-package-broker.exe';
const RUNTIME_TARGET = 'runtime/windows-amd64/package-runtime.json';
const TRUST_TARGET = 'package-install-trust.json';
const BROKER_PIPE_NAME = String.raw`\\.\pipe\yucp.package-broker.v1`;
const INFISICAL_KEYS = [
  'CATALOG_DATABASE_URL',
  'METADATA_S3_ENDPOINT',
  'METADATA_S3_REGION',
  'METADATA_S3_BUCKET',
  'METADATA_S3_ACCESS_KEY_ID',
  'METADATA_S3_SECRET_ACCESS_KEY',
  'PACKAGE_INSTALLER_TUF_REPOSITORY_ID',
] as const;
const OFFLINE_AUTHORITY_KEYS = [
  'PACKAGE_INSTALL_SIGNING_KEY_ID',
  'PACKAGE_INSTALL_SIGNING_PUBLIC_KEY',
  'MATERIALIZATION_RECEIPT_KEY_ID',
  'MATERIALIZATION_RECEIPT_PUBLIC_KEY',
] as const;
const OFFLINE_SIGNING_KEYS = [
  'YUCP_TUF_TARGETS_PRIVATE_KEY',
  'YUCP_TUF_SNAPSHOT_PRIVATE_KEY',
  'YUCP_TUF_TIMESTAMP_PRIVATE_KEY',
] as const;
const OFFLINE_CONNECTIVITY_KEYS = ['CATALOG_DATABASE_URL'] as const;
const REQUIRED_KEYS = [
  ...INFISICAL_KEYS,
  ...OFFLINE_AUTHORITY_KEYS,
  ...OFFLINE_SIGNING_KEYS,
  'PACKAGE_INSTALLER_TUF_ROOT_PATH',
  'PACKAGE_INSTALLER_TUF_ROOT_SHA256',
  'PACKAGE_INSTALLER_TUF_BROKER_WINDOWS_AMD64_PATH',
  'PACKAGE_INSTALLER_TUF_HELPER_WINDOWS_AMD64_PATH',
  'PACKAGE_INSTALLER_API_BASE_URL',
  'PACKAGE_INSTALLER_AUTH_BASE_URL',
  'PACKAGE_INSTALLER_TUF_METADATA_URL',
  'PACKAGE_INSTALLER_TUF_TARGETS_URL',
  'PACKAGE_INSTALLER_TUF_PUBLICATION_ATTEMPT_ID',
  'PACKAGE_INSTALLER_TUF_PUBLISHER_EXECUTABLE',
] as const;

type HydratePublicationEnv = (
  env: NodeJS.ProcessEnv,
  requiredKeys: readonly string[]
) => Promise<NodeJS.ProcessEnv>;

export async function resolvePackageInstallerPublicationEnv(
  sourceEnv: NodeJS.ProcessEnv,
  hydrate: HydratePublicationEnv = hydrateStorageServiceEnv
): Promise<NodeJS.ProcessEnv> {
  const hydrated = await hydrate(sourceEnv, INFISICAL_KEYS);
  const offlineInputs: NodeJS.ProcessEnv = {};
  for (const key of [...OFFLINE_AUTHORITY_KEYS, ...OFFLINE_SIGNING_KEYS]) {
    const value = sourceEnv[key]?.trim();
    if (!value) {
      throw new Error(`Missing required offline TUF authority input: ${key}`);
    }
    offlineInputs[key] = value;
  }
  const connectivity: NodeJS.ProcessEnv = {};
  for (const key of OFFLINE_CONNECTIVITY_KEYS) {
    const value = sourceEnv[key]?.trim();
    if (value) {
      connectivity[key] = value;
    }
  }
  return {
    ...hydrated,
    ...offlineInputs,
    ...connectivity,
  };
}

function required(env: NodeJS.ProcessEnv, key: (typeof REQUIRED_KEYS)[number]): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required TUF publisher setting: ${key}`);
  }
  return value;
}

function requireAbsoluteFile(value: string, name: string): string {
  if (!path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return value;
}

function sha256(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

function requireCanonicalHttpsUrl(raw: string, name: string): string {
  if (raw !== raw.trim() || raw.endsWith('/')) {
    throw new Error(`${name} URL is not canonical`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} URL is invalid`);
  }
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${name} URL must use canonical HTTPS`);
  }
  const serialized =
    parsed.pathname === '/' && raw === parsed.origin ? parsed.origin : parsed.toString();
  if (serialized !== raw) {
    throw new Error(`${name} URL is not canonical`);
  }
  return raw;
}

export function buildRuntimeDescriptor(input: {
  apiBaseUrl: string;
  authBaseUrl: string;
  metadataUrl: string;
  targetsUrl: string;
}): Buffer {
  const apiBaseUrl = requireCanonicalHttpsUrl(input.apiBaseUrl, 'Package API');
  const authBaseUrl = requireCanonicalHttpsUrl(input.authBaseUrl, 'Package authorization');
  const metadataUrl = requireCanonicalHttpsUrl(input.metadataUrl, 'Package TUF metadata');
  const targetsUrl = requireCanonicalHttpsUrl(input.targetsUrl, 'Package TUF targets');
  const metadataRepositoryUrl = new URL(metadataUrl);
  const targetsRepositoryUrl = new URL(targetsUrl);
  if (
    metadataRepositoryUrl.origin !== targetsRepositoryUrl.origin ||
    metadataRepositoryUrl.pathname !== '/api/v2/package-installer/tuf/metadata' ||
    targetsRepositoryUrl.pathname !== '/api/v2/package-installer/tuf/targets'
  ) {
    throw new Error('Package TUF URLs must use the signed repository routes');
  }
  return Buffer.from(
    JSON.stringify({
      apiBaseUrl,
      authBaseUrl,
      brokerTarget: BROKER_TARGET,
      helperTarget: HELPER_TARGET,
      metadataUrl,
      pipeName: BROKER_PIPE_NAME,
      platform: 'windows-amd64',
      schemaVersion: 1,
      targetsUrl,
      trustTarget: TRUST_TARGET,
    })
  );
}

export function verifyPinnedRoot(root: Uint8Array, expectedSha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error('PACKAGE_INSTALLER_TUF_ROOT_SHA256 must be canonical lowercase SHA-256');
  }
  const actualSha256 = sha256(root);
  if (!timingSafeEqual(Buffer.from(actualSha256, 'hex'), Buffer.from(expectedSha256, 'hex'))) {
    throw new Error('The TUF root does not match the offline ceremony pin');
  }
  return actualSha256;
}

function consistentTargetPath(targetName: string, body: Uint8Array): string {
  const parsed = path.posix.parse(targetName);
  return path.posix.join(parsed.dir, `${sha256(body)}.${parsed.base}`);
}

function requireAuthority(keyId: string, publicKey: string, name: string): void {
  const decoded = Buffer.from(publicKey, 'base64url');
  if (
    !keyId ||
    Buffer.byteLength(keyId, 'utf8') > 64 ||
    decoded.byteLength !== 32 ||
    decoded.toString('base64url') !== publicKey
  ) {
    throw new Error(`${name} authority is invalid`);
  }
}

function parseRootVersion(root: Uint8Array): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(root));
  } catch {
    throw new Error('TUF root must contain valid UTF-8 JSON');
  }
  const version =
    parsed &&
    typeof parsed === 'object' &&
    'signed' in parsed &&
    parsed.signed &&
    typeof parsed.signed === 'object' &&
    'version' in parsed.signed
      ? parsed.signed.version
      : null;
  if (!Number.isSafeInteger(version) || Number(version) < 1) {
    throw new Error('TUF root version is invalid');
  }
  return Number(version);
}

async function runMetadataBuilder(input: {
  env: NodeJS.ProcessEnv;
  manifestPath: string;
  metadataVersion: number;
  outputRoot: string;
  rootPath: string;
  snapshotExpiresAt: Date;
  targetsExpiresAt: Date;
  timestampExpiresAt: Date;
}): Promise<void> {
  const executable = requireAbsoluteFile(
    required(input.env, 'PACKAGE_INSTALLER_TUF_PUBLISHER_EXECUTABLE'),
    'PACKAGE_INSTALLER_TUF_PUBLISHER_EXECUTABLE'
  );
  const child = Bun.spawn(
    [
      executable,
      '--output',
      input.outputRoot,
      '--root',
      input.rootPath,
      '--targets-manifest',
      input.manifestPath,
      '--metadata-version',
      String(input.metadataVersion),
      '--targets-expires',
      input.targetsExpiresAt.toISOString(),
      '--snapshot-expires',
      input.snapshotExpiresAt.toISOString(),
      '--timestamp-expires',
      input.timestampExpiresAt.toISOString(),
    ],
    {
      env: {
        YUCP_TUF_SNAPSHOT_PRIVATE_KEY: required(input.env, 'YUCP_TUF_SNAPSHOT_PRIVATE_KEY'),
        YUCP_TUF_TARGETS_PRIVATE_KEY: required(input.env, 'YUCP_TUF_TARGETS_PRIVATE_KEY'),
        YUCP_TUF_TIMESTAMP_PRIVATE_KEY: required(input.env, 'YUCP_TUF_TIMESTAMP_PRIVATE_KEY'),
      },
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    }
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    const reason = stderr.trim() || 'no diagnostic';
    throw new Error(`TUF metadata builder failed with exit code ${exitCode}: ${reason}`);
  }
  let result: unknown;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error('TUF metadata builder returned invalid JSON');
  }
  if (
    !result ||
    typeof result !== 'object' ||
    !('metadataVersion' in result) ||
    result.metadataVersion !== input.metadataVersion
  ) {
    throw new Error('TUF metadata builder returned the wrong publication version');
  }
}

async function readGeneratedBundle(input: {
  metadataVersion: number;
  outputRoot: string;
  repositoryId: string;
  rootVersion: number;
  targetFiles: Array<{
    contentType: string;
    repositoryPath: string;
  }>;
}): Promise<VerifiedTufRepositoryBundle> {
  const metadataRoot = path.join(input.outputRoot, 'metadata');
  const targetsRoot = path.join(input.outputRoot, 'targets');
  return {
    metadataVersion: input.metadataVersion,
    repositoryId: input.repositoryId,
    root: {
      body: await readFile(path.join(metadataRoot, `${input.rootVersion}.root.json`)),
      path: `${input.rootVersion}.root.json`,
    },
    snapshot: {
      body: await readFile(path.join(metadataRoot, `${input.metadataVersion}.snapshot.json`)),
      path: `${input.metadataVersion}.snapshot.json`,
    },
    targets: {
      body: await readFile(path.join(metadataRoot, `${input.metadataVersion}.targets.json`)),
      path: `${input.metadataVersion}.targets.json`,
    },
    targetFiles: await Promise.all(
      input.targetFiles.map(async (target) => ({
        body: await readFile(path.join(targetsRoot, ...target.repositoryPath.split('/'))),
        contentType: target.contentType,
        path: target.repositoryPath,
      }))
    ),
    timestamp: {
      body: await readFile(path.join(metadataRoot, 'timestamp.json')),
      path: 'timestamp.json',
    },
    verifiedAt: new Date(),
  };
}

export async function publishPackageInstallerTuf(
  sourceEnv: NodeJS.ProcessEnv = process.env
): Promise<{ metadataVersion: number; publicationId: string }> {
  // Service credentials remain authoritative in Infisical. The online-role TUF
  // private keys stay in the explicit offline publication invocation.
  const env = await resolvePackageInstallerPublicationEnv(sourceEnv);
  const repositoryId = required(env, 'PACKAGE_INSTALLER_TUF_REPOSITORY_ID');
  const rootPath = requireAbsoluteFile(
    required(env, 'PACKAGE_INSTALLER_TUF_ROOT_PATH'),
    'PACKAGE_INSTALLER_TUF_ROOT_PATH'
  );
  const helperPath = requireAbsoluteFile(
    required(env, 'PACKAGE_INSTALLER_TUF_HELPER_WINDOWS_AMD64_PATH'),
    'PACKAGE_INSTALLER_TUF_HELPER_WINDOWS_AMD64_PATH'
  );
  const brokerPath = requireAbsoluteFile(
    required(env, 'PACKAGE_INSTALLER_TUF_BROKER_WINDOWS_AMD64_PATH'),
    'PACKAGE_INSTALLER_TUF_BROKER_WINDOWS_AMD64_PATH'
  );
  const publicationAttemptId = required(env, 'PACKAGE_INSTALLER_TUF_PUBLICATION_ATTEMPT_ID');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(publicationAttemptId)) {
    throw new Error('PACKAGE_INSTALLER_TUF_PUBLICATION_ATTEMPT_ID is invalid');
  }
  const [root, helper, broker] = await Promise.all([
    readFile(rootPath),
    readFile(helperPath),
    readFile(brokerPath),
  ]);
  if (helper.byteLength < 1 || helper.byteLength > MAX_PACKAGE_INSTALLER_HELPER_BYTES) {
    throw new Error('Package installer helper length is invalid');
  }
  if (broker.byteLength < 1 || broker.byteLength > MAX_PACKAGE_INSTALLER_HELPER_BYTES) {
    throw new Error('Package broker length is invalid');
  }
  verifyPinnedRoot(root, required(env, 'PACKAGE_INSTALLER_TUF_ROOT_SHA256'));
  const rootVersion = parseRootVersion(root);
  const installKeyId = required(env, 'PACKAGE_INSTALL_SIGNING_KEY_ID');
  const installPublicKey = required(env, 'PACKAGE_INSTALL_SIGNING_PUBLIC_KEY');
  const receiptKeyId = required(env, 'MATERIALIZATION_RECEIPT_KEY_ID');
  const receiptPublicKey = required(env, 'MATERIALIZATION_RECEIPT_PUBLIC_KEY');
  requireAuthority(installKeyId, installPublicKey, 'Package install');
  requireAuthority(receiptKeyId, receiptPublicKey, 'Materialization receipt');
  const trust = Buffer.from(
    JSON.stringify({
      materializationReceipt: {
        keyId: receiptKeyId,
        publicKey: receiptPublicKey,
      },
      packageInstall: {
        keyId: installKeyId,
        publicKey: installPublicKey,
      },
      schemaVersion: 1,
    })
  );
  const runtime = buildRuntimeDescriptor({
    apiBaseUrl: required(env, 'PACKAGE_INSTALLER_API_BASE_URL'),
    authBaseUrl: required(env, 'PACKAGE_INSTALLER_AUTH_BASE_URL'),
    metadataUrl: required(env, 'PACKAGE_INSTALLER_TUF_METADATA_URL'),
    targetsUrl: required(env, 'PACKAGE_INSTALLER_TUF_TARGETS_URL'),
  });
  const targetFiles = [
    {
      body: helper,
      contentType: 'application/vnd.microsoft.portable-executable',
      name: HELPER_TARGET,
    },
    {
      body: broker,
      contentType: 'application/vnd.microsoft.portable-executable',
      name: BROKER_TARGET,
    },
    {
      body: runtime,
      contentType: 'application/json',
      name: RUNTIME_TARGET,
    },
    {
      body: trust,
      contentType: 'application/json',
      name: TRUST_TARGET,
    },
  ].map((target) => ({
    ...target,
    repositoryPath: consistentTargetPath(target.name, target.body),
  }));
  const idempotencyKey =
    `package-installer:${publicationAttemptId}:` +
    sha256(Buffer.concat([root, helper, broker, runtime, trust]));
  const database = openCatalogDatabase(required(env, 'CATALOG_DATABASE_URL'));
  const scratch = await mkdtemp(path.join(tmpdir(), 'yucp-tuf-publish-'));
  try {
    await runCatalogMigrations(database);
    const catalog = new TufRepositoryCatalog(database);
    const publication = await catalog.reservePublication({
      idempotencyKey,
      repositoryId,
      rootVersion,
      targetPaths: targetFiles.map((target) => `targets/${target.repositoryPath}`),
    });
    if (publication.state === 'PUBLISHED') {
      return {
        metadataVersion: publication.metadataVersion,
        publicationId: publication.id,
      };
    }
    const manifestPath = path.join(scratch, 'targets.json');
    const outputRoot = path.join(scratch, 'repository');
    const runtimePath = path.join(scratch, 'package-runtime.json');
    const trustPath = path.join(scratch, 'package-install-trust.json');
    await writeFile(runtimePath, runtime);
    await writeFile(trustPath, trust);
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        targets: [
          { name: BROKER_TARGET, path: brokerPath },
          { name: HELPER_TARGET, path: helperPath },
          { name: RUNTIME_TARGET, path: runtimePath },
          { name: TRUST_TARGET, path: trustPath },
        ],
      })}\n`
    );
    await runMetadataBuilder({
      env,
      manifestPath,
      metadataVersion: publication.metadataVersion,
      outputRoot,
      rootPath,
      snapshotExpiresAt: publication.snapshotExpiresAt,
      targetsExpiresAt: publication.targetsExpiresAt,
      timestampExpiresAt: publication.timestampExpiresAt,
    });
    const bundle = await readGeneratedBundle({
      metadataVersion: publication.metadataVersion,
      outputRoot,
      repositoryId,
      rootVersion,
      targetFiles,
    });
    const storagePort = new S3ExactStoragePort({
      metadata: loadStorageRoleConfig(env, STORAGE_ROLE_PREFIXES.metadata),
    });
    const durableStorage = new DurableExactStorage(new ExactStorageCatalog(database), storagePort);
    await publishTufRepository({
      bundle,
      catalog,
      publicationId: publication.id,
      storage: durableStorage,
    });
    return {
      metadataVersion: publication.metadataVersion,
      publicationId: publication.id,
    };
  } finally {
    await database.end({ timeout: 5 });
    await rm(scratch, { force: true, recursive: true });
  }
}

if (import.meta.main) {
  publishPackageInstallerTuf()
    .then((published) => {
      console.info(
        JSON.stringify({
          event: 'package_installer_tuf.published',
          metadataVersion: published.metadataVersion,
          publicationId: published.publicationId,
        })
      );
    })
    .catch((error) => {
      console.error(
        JSON.stringify({
          event: 'package_installer_tuf.publish_failed',
          reason: error instanceof Error ? error.message : 'unknown_error',
        })
      );
      process.exitCode = 1;
    });
}
