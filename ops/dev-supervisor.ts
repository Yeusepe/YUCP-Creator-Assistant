import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import * as ed25519 from '@noble/ed25519';
import { fetchInfisicalSecrets } from '@yucp/shared/infisical/fetchSecrets';
import { parse as parseDotenv } from 'dotenv';
import {
  BETTER_AUTH_SECRET as SELF_HOSTED_BETTER_AUTH_SECRET,
  API_SECRET as SELF_HOSTED_CONVEX_API_SECRET,
  ENCRYPTION_SECRET as SELF_HOSTED_ENCRYPTION_SECRET,
  INTERNAL_SERVICE_AUTH_SECRET as SELF_HOSTED_INTERNAL_SERVICE_AUTH_SECRET,
} from './convex-real/config';
import {
  enableRealBackendTestHelpers,
  ensureConvexDependenciesResolvable,
  ensureRealBackendUp,
  getRealBackendAdminKey,
  isRealBackendHealthy,
  runSelfHostedConvexCli,
  type SelfHostedConvexProfile,
  selfHostedConvexEnv,
  stopRealBackend,
  withSelfHostedConvexEnvFileMovedAside,
} from './convex-real/manage';
import {
  buildLocalImporterReleaseLedger,
  buildLocalImporterRepository,
  resolveLocalImporterPackagePath,
} from './importer/localVpmRepository';
import {
  createNativeRuntimeRelease,
  type NativeRuntimePublisherIdentity,
  type NativeRuntimePublisherTrustMode,
  readNativeRuntimeReleaseManifest,
} from './importer/nativeRuntimeRelease';
import { DESYNC_STORAGE_FORMAT_VERSION } from './storage-core/deliveryManifest';
import {
  type DisposableStorageHarness,
  startDisposableStorageHarness,
} from './testing/disposableStorageHarness';
import {
  type InteractiveDevSecrets,
  type InteractiveStorageHarness,
  startInteractiveStorageHarness,
} from './testing/interactiveStorageHarness';

const execFileAsync = promisify(execFile);
const ROOT_DIR = process.cwd();
const DEV_FRONTEND_URL = 'http://localhost:3000';
const DEV_HYPERDX_APP_URL = 'http://localhost:8080';
const DEV_HYPERDX_OTLP_HTTP_URL = 'http://localhost:4318';
const DEV_HYPERDX_OTLP_GRPC_URL = 'localhost:4317';
const DEV_HYPERDX_USE_REMOTE_FLAG = 'HYPERDX_DEV_USE_REMOTE';
const DEV_MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
const PREFIX_RESET = '\u001B[0m';
const PREFIX_COLORS = {
  blue: '\u001B[34m',
  magenta: '\u001B[35m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  cyan: '\u001B[36m',
  red: '\u001B[31m',
} as const;

export type PrefixColor = keyof typeof PREFIX_COLORS;

export interface DevCommandSpec {
  name: string;
  color: PrefixColor;
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  required?: boolean;
}

export interface DevPortSet {
  api: number;
  coupling: number;
  convexBackend: number;
  convexDashboard: number;
  convexSite: number;
  delivery: number;
  hyperdxApp: number;
  hyperdxOtlpGrpc: number;
  hyperdxOtlpHttp: number;
  ingest: number;
  materializationControl: number;
  materializationSource: number;
  publicVpm: number;
  web: number;
}

export const DEFAULT_DEV_PORTS: DevPortSet = {
  api: 3001,
  coupling: 8788,
  convexBackend: 3210,
  convexDashboard: 6791,
  convexSite: 3211,
  delivery: 3003,
  hyperdxApp: 8080,
  hyperdxOtlpGrpc: 4317,
  hyperdxOtlpHttp: 4318,
  ingest: 3002,
  materializationControl: 3012,
  materializationSource: 3005,
  publicVpm: 3004,
  web: 3000,
};

export function buildDevReadinessEndpoints(ports: DevPortSet): string[] {
  return [
    `http://127.0.0.1:${ports.api}/health`,
    `http://localhost:${ports.web}/@vite/client`,
    `http://localhost:${ports.ingest}/healthz`,
    `http://127.0.0.1:${ports.delivery}/`,
    `http://127.0.0.1:${ports.publicVpm}/index.json`,
    `http://127.0.0.1:${ports.materializationSource}/`,
    `http://127.0.0.1:${ports.materializationControl}/`,
    `http://127.0.0.1:${ports.coupling}/v2/health`,
    `http://127.0.0.1:${ports.hyperdxApp}/`,
  ];
}

export async function allocateDevPortSet(): Promise<DevPortSet> {
  const names = Object.keys(DEFAULT_DEV_PORTS) as Array<keyof DevPortSet>;
  const servers: Server[] = [];
  const ports = {} as DevPortSet;
  try {
    for (const name of names) {
      const server = createServer();
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Loopback port allocation returned no TCP address');
      }
      ports[name] = address.port;
    }
    return ports;
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          })
      )
    );
  }
}

export async function waitForDevHttpReadiness(
  endpoints: readonly string[],
  timeoutMs = 180_000
): Promise<void> {
  const pending = new Set(endpoints);
  const deadline = Date.now() + timeoutMs;
  while (pending.size > 0 && Date.now() < deadline) {
    for (const endpoint of pending) {
      try {
        const response = await fetch(endpoint, {
          redirect: 'manual',
          signal: AbortSignal.timeout(2_000),
        });
        await response.body?.cancel().catch(() => undefined);
        pending.delete(endpoint);
      } catch {
        // The bounded readiness loop retries until each listener responds.
      }
    }
    if (pending.size > 0) {
      await sleep(250);
    }
  }
  if (pending.size > 0) {
    throw new Error(`Development runtime readiness timed out for ${[...pending].join(', ')}`);
  }
}

interface DevSupervisorOptions {
  prefixOutput?: boolean;
}

export interface DevRuntime {
  convex?: {
    adminKey: string;
    backendUrl: string;
    siteUrl: string;
  };
  env: NodeJS.ProcessEnv;
  runId: string;
  urls: {
    api: string;
    coupling: string;
    delivery: string;
    ingest: string;
    materializationControl: string;
    materializationSource: string;
    publicVpm: string;
    web: string;
  };
  storage: DisposableStorageHarness | InteractiveStorageHarness;
  stop: (signal?: NodeJS.Signals) => Promise<void>;
  supervisor: DevSupervisor;
  waitUntilReady: () => Promise<void>;
  waitForExit: () => Promise<number>;
}

export interface StartDisposableDevRuntimeOptions {
  betterAuthAdditionalTrustedOrigins?: readonly string[];
  commands?: readonly DevCommandSpec[];
  convexProfile?: 'development' | 'self-hosted';
  infisical?: boolean;
  importerPackagePath?: string;
  packageRuntimeAuthBaseUrl?: string;
  ports?: DevPortSet;
  prefixOutput?: boolean;
}

export type StartInteractiveDevRuntimeOptions = StartDisposableDevRuntimeOptions;

function interactiveRuntimeSecrets(
  storage: DisposableStorageHarness | InteractiveStorageHarness
): InteractiveDevSecrets | undefined {
  return 'persistent' in storage && storage.persistent === true
    ? storage.runtimeSecrets
    : undefined;
}

const DEFAULT_COMMANDS: readonly DevCommandSpec[] = [
  {
    name: 'convex',
    color: 'blue',
    command: 'bunx convex dev --run seedYucpOAuthClient:seedPackageBrokerOAuthClient',
  },
  { name: 'api', color: 'magenta', command: 'bun run dev:api' },
  { name: 'bot', color: 'green', command: 'bun run dev:bot' },
  { name: 'web', color: 'yellow', command: 'bun run dev:web' },
  { name: 'hyperdx', color: 'cyan', command: 'bun run dev:hyperdx' },
  {
    name: 'ingest-tus',
    color: 'cyan',
    command: 'bun run --watch ops/ingest-tus/server.ts',
    env: { PORT: '3002' },
  },
  { name: 'scheduler', color: 'blue', command: 'bun run ops/scheduler/server.ts' },
  {
    name: 'storage-gc',
    color: 'yellow',
    command: 'bun run ops/gc/server.ts',
    required: true,
  },
  {
    name: 'materialization-control',
    color: 'red',
    command: 'bun run --watch ops/materialization/server.ts',
  },
];

const INFISICAL_COMMANDS: readonly DevCommandSpec[] = [
  {
    name: 'convex',
    color: 'blue',
    command: 'bunx convex dev --run seedYucpOAuthClient:seedPackageBrokerOAuthClient',
  },
  { name: 'api', color: 'magenta', command: 'bun run dev:api:infisical' },
  { name: 'bot', color: 'green', command: 'bun run dev:bot:infisical' },
  { name: 'web', color: 'yellow', command: 'bun run dev:web:infisical' },
  { name: 'hyperdx', color: 'cyan', command: 'bun run dev:hyperdx:infisical' },
  {
    name: 'ingest-tus',
    color: 'cyan',
    command: 'bun run --watch ops/ingest-tus/server.ts',
    env: { PORT: '3002' },
  },
  { name: 'scheduler', color: 'blue', command: 'bun run ops/scheduler/server.ts' },
  {
    name: 'storage-gc',
    color: 'yellow',
    command: 'bun run ops/gc/server.ts',
    required: true,
  },
  {
    name: 'materialization-control',
    color: 'red',
    command: 'bun run --watch ops/materialization/server.ts',
  },
];

const TUNNEL_COMMAND: DevCommandSpec = {
  name: 'tunnel',
  color: 'cyan',
  command: 'tailscale funnel 3001',
  required: false,
};
const WINDOWS_TASKKILL_TIMEOUT_MS = 2_000;
const WINDOWS_POWERSHELL_KILL_TIMEOUT_MS = 5_000;

export function buildDevCommands(
  baseEnv: NodeJS.ProcessEnv = process.env,
  infisical = false,
  ports: DevPortSet = DEFAULT_DEV_PORTS
): readonly DevCommandSpec[] {
  const webUrl = `http://localhost:${ports.web}`;
  const apiUrl = `http://127.0.0.1:${ports.api}`;
  const materializationSourceUrl = `http://127.0.0.1:${ports.materializationSource}`;
  const commands = (infisical ? INFISICAL_COMMANDS : DEFAULT_COMMANDS).map(
    (command): DevCommandSpec => {
      const env = { ...command.env };
      if (command.name === 'api') {
        Object.assign(env, { FRONTEND_URL: webUrl, PORT: String(ports.api) });
        if (ports.api !== DEFAULT_DEV_PORTS.api) {
          return {
            ...command,
            command: 'bun run --watch apps/api/src/index.ts',
            env,
          };
        }
      }
      if (command.name === 'web') {
        Object.assign(env, {
          API_BASE_URL: apiUrl,
          WEB_DEV_PORT: String(ports.web),
        });
      }
      if (command.name === 'ingest-tus') {
        env.PORT = String(ports.ingest);
      }
      if (command.name === 'hyperdx') {
        Object.assign(env, {
          HYPERDX_APP_PORT: String(ports.hyperdxApp),
          HYPERDX_OTLP_GRPC_PORT: String(ports.hyperdxOtlpGrpc),
          HYPERDX_OTLP_HTTP_PORT: String(ports.hyperdxOtlpHttp),
        });
      }
      if (command.name === 'materialization-control') {
        env.MATERIALIZATION_CONTROL_PLANE_PORT = String(ports.materializationControl);
      }
      return { ...command, env };
    }
  );
  commands.push(
    {
      name: 'delivery',
      color: 'magenta',
      command: 'bun x tsx watch services/delivery-worker/testDevServer.ts',
      env: {
        BUYER_FLOW_COMMON_CHUNK_PREFIX: baseEnv.COMMON_CHUNK_PREFIX ?? 'chunks/',
        BUYER_FLOW_COMMON_S3_BUCKET: baseEnv.COMMON_S3_BUCKET,
        BUYER_FLOW_COMMON_S3_ENDPOINT: baseEnv.COMMON_S3_ENDPOINT,
        BUYER_FLOW_COMMON_S3_READONLY_ACCESS_KEY_ID: baseEnv.COMMON_S3_ACCESS_KEY_ID,
        BUYER_FLOW_COMMON_S3_READONLY_SECRET_ACCESS_KEY: baseEnv.COMMON_S3_SECRET_ACCESS_KEY,
        BUYER_FLOW_COMMON_S3_REGION: baseEnv.COMMON_S3_REGION,
        BUYER_FLOW_METADATA_INDEX_PREFIX: baseEnv.METADATA_INDEX_PREFIX ?? 'indexes/',
        BUYER_FLOW_METADATA_S3_BUCKET: baseEnv.METADATA_S3_BUCKET,
        BUYER_FLOW_METADATA_S3_ENDPOINT: baseEnv.METADATA_S3_ENDPOINT,
        BUYER_FLOW_METADATA_S3_READONLY_ACCESS_KEY_ID: baseEnv.METADATA_S3_ACCESS_KEY_ID,
        BUYER_FLOW_METADATA_S3_READONLY_SECRET_ACCESS_KEY: baseEnv.METADATA_S3_SECRET_ACCESS_KEY,
        BUYER_FLOW_METADATA_S3_REGION: baseEnv.METADATA_S3_REGION,
        BUYER_FLOW_PACKAGE_DELIVERY_AUDIENCE: baseEnv.PACKAGE_DELIVERY_AUDIENCE,
        BUYER_FLOW_PACKAGE_INSTALL_ISSUER: baseEnv.PACKAGE_INSTALL_ISSUER,
        BUYER_FLOW_PACKAGE_INSTALL_SIGNING_KEY_ID: baseEnv.PACKAGE_INSTALL_SIGNING_KEY_ID,
        BUYER_FLOW_PACKAGE_INSTALL_SIGNING_PUBLIC_KEY: baseEnv.PACKAGE_INSTALL_SIGNING_PUBLIC_KEY,
        BUYER_FLOW_RENDITION_PACKAGE_DELIVERY_AUDIENCE: baseEnv.PACKAGE_DELIVERY_AUDIENCE,
        BUYER_FLOW_RENDITION_PACKAGE_INSTALL_ISSUER: baseEnv.PACKAGE_INSTALL_ISSUER,
        BUYER_FLOW_RENDITION_PACKAGE_INSTALL_SIGNING_KEY_ID: baseEnv.PACKAGE_INSTALL_SIGNING_KEY_ID,
        BUYER_FLOW_RENDITION_PACKAGE_INSTALL_SIGNING_PUBLIC_KEY:
          baseEnv.PACKAGE_INSTALL_SIGNING_PUBLIC_KEY,
        BUYER_FLOW_RENDITION_RENDITION_RECEIPT_KEY_ID: baseEnv.MATERIALIZATION_RECEIPT_KEY_ID,
        BUYER_FLOW_RENDITION_RENDITION_RECEIPT_PUBLIC_KEY:
          baseEnv.MATERIALIZATION_RECEIPT_PUBLIC_KEY,
        BUYER_FLOW_RENDITION_RENDITION_S3_BUCKET: baseEnv.RENDITION_S3_BUCKET,
        BUYER_FLOW_RENDITION_RENDITION_S3_ENDPOINT: baseEnv.RENDITION_S3_ENDPOINT,
        BUYER_FLOW_RENDITION_RENDITION_S3_READONLY_ACCESS_KEY_ID:
          baseEnv.RENDITION_S3_ACCESS_KEY_ID,
        BUYER_FLOW_RENDITION_RENDITION_S3_READONLY_SECRET_ACCESS_KEY:
          baseEnv.RENDITION_S3_SECRET_ACCESS_KEY,
        BUYER_FLOW_RENDITION_RENDITION_S3_REGION: baseEnv.RENDITION_S3_REGION,
        BUYER_FLOW_DELIVERY_PORT: String(ports.delivery),
        BUYER_FLOW_KEEP_ALIVE: '1',
        BUYER_FLOW_STORAGE_FORMAT_VERSION: DESYNC_STORAGE_FORMAT_VERSION,
      },
    },
    {
      name: 'vpm-public',
      color: 'green',
      command: 'bun run ops/importer/localVpmServer.ts',
      env: { PORT: String(ports.publicVpm) },
    },
    {
      name: 'materialization-source',
      color: 'red',
      command: 'bun x tsx watch services/materialization-source-worker/testDevServer.ts',
      env: {
        MATERIALIZATION_SOURCE_WORKER_COMMON_CHUNK_PREFIX: baseEnv.COMMON_CHUNK_PREFIX ?? 'chunks/',
        MATERIALIZATION_SOURCE_WORKER_COMMON_S3_BUCKET: baseEnv.COMMON_S3_BUCKET,
        MATERIALIZATION_SOURCE_WORKER_COMMON_S3_ENDPOINT: baseEnv.COMMON_S3_ENDPOINT,
        MATERIALIZATION_SOURCE_WORKER_COMMON_S3_READONLY_ACCESS_KEY_ID:
          baseEnv.COMMON_S3_ACCESS_KEY_ID,
        MATERIALIZATION_SOURCE_WORKER_COMMON_S3_READONLY_SECRET_ACCESS_KEY:
          baseEnv.COMMON_S3_SECRET_ACCESS_KEY,
        MATERIALIZATION_SOURCE_WORKER_COMMON_S3_REGION: baseEnv.COMMON_S3_REGION,
        MATERIALIZATION_SOURCE_WORKER_DELIVERY_GRANT_ISSUER:
          baseEnv.MATERIALIZATION_SOURCE_GRANT_ISSUER,
        MATERIALIZATION_SOURCE_WORKER_DELIVERY_GRANT_KEY_ID:
          baseEnv.MATERIALIZATION_SOURCE_GRANT_KEY_ID,
        MATERIALIZATION_SOURCE_WORKER_DELIVERY_GRANT_PUBLIC_KEY:
          baseEnv.MATERIALIZATION_SOURCE_GRANT_PUBLIC_KEY,
        MATERIALIZATION_SOURCE_WORKER_KEEP_ALIVE: '1',
        MATERIALIZATION_SOURCE_WORKER_MATERIALIZATION_SOURCE_AUDIENCE:
          baseEnv.MATERIALIZATION_SOURCE_GRANT_AUDIENCE,
        MATERIALIZATION_SOURCE_WORKER_METADATA_INDEX_PREFIX:
          baseEnv.METADATA_INDEX_PREFIX ?? 'indexes/',
        MATERIALIZATION_SOURCE_WORKER_METADATA_S3_BUCKET: baseEnv.METADATA_S3_BUCKET,
        MATERIALIZATION_SOURCE_WORKER_METADATA_S3_ENDPOINT: baseEnv.METADATA_S3_ENDPOINT,
        MATERIALIZATION_SOURCE_WORKER_METADATA_S3_READONLY_ACCESS_KEY_ID:
          baseEnv.METADATA_S3_ACCESS_KEY_ID,
        MATERIALIZATION_SOURCE_WORKER_METADATA_S3_READONLY_SECRET_ACCESS_KEY:
          baseEnv.METADATA_S3_SECRET_ACCESS_KEY,
        MATERIALIZATION_SOURCE_WORKER_METADATA_S3_REGION: baseEnv.METADATA_S3_REGION,
        MATERIALIZATION_SOURCE_WORKER_PORT: String(ports.materializationSource),
        MATERIALIZATION_SOURCE_WORKER_PROTECTED_CHUNK_PREFIX:
          baseEnv.PROTECTED_CHUNK_PREFIX ?? 'chunks/',
        MATERIALIZATION_SOURCE_WORKER_PROTECTED_S3_BUCKET: baseEnv.PROTECTED_S3_BUCKET,
        MATERIALIZATION_SOURCE_WORKER_PROTECTED_S3_ENDPOINT: baseEnv.PROTECTED_S3_ENDPOINT,
        MATERIALIZATION_SOURCE_WORKER_PROTECTED_S3_READONLY_ACCESS_KEY_ID:
          baseEnv.PROTECTED_S3_ACCESS_KEY_ID,
        MATERIALIZATION_SOURCE_WORKER_PROTECTED_S3_READONLY_SECRET_ACCESS_KEY:
          baseEnv.PROTECTED_S3_SECRET_ACCESS_KEY,
        MATERIALIZATION_SOURCE_WORKER_PROTECTED_S3_REGION: baseEnv.PROTECTED_S3_REGION,
        MATERIALIZATION_SOURCE_WORKER_STORAGE_FORMAT_VERSION: DESYNC_STORAGE_FORMAT_VERSION,
      },
    }
  );
  commands.push({
    name: 'materializer-linux',
    color: 'red',
    command: 'bun run ops/materialization/localWslMaterializer.ts',
    env: {
      MATERIALIZATION_CONTROL_PLANE_BASE_URL: `http://127.0.0.1:${ports.materializationControl}`,
      MATERIALIZATION_HEALTH_PORT: String(ports.coupling),
      MATERIALIZATION_SOURCE_BASE_URL: materializationSourceUrl,
    },
  });
  commands.push(TUNNEL_COMMAND);
  return commands;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolvePackageRuntimeAuthBaseUrl(
  env: NodeJS.ProcessEnv,
  configuredUrl: string | undefined
): string {
  const explicitUrl = configuredUrl?.trim() || env.BETTER_AUTH_URL?.trim();
  const convexSiteUrl = env.CONVEX_SITE_URL?.trim();
  const rawUrl =
    explicitUrl || (convexSiteUrl ? `${convexSiteUrl.replace(/\/$/, '')}/api/auth` : '');
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      'BETTER_AUTH_URL, CONVEX_SITE_URL, or packageRuntimeAuthBaseUrl is required for the local package runtime'
    );
  }
  const loopbackHttp =
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]');
  if (
    (parsed.protocol !== 'https:' && !loopbackHttp) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname === '/' ||
    rawUrl.endsWith('/') ||
    parsed.toString() !== rawUrl
  ) {
    throw new Error('The local package runtime authorization URL is invalid');
  }
  return rawUrl;
}

type LocalNativeRuntimeRelease = {
  cleanup: () => Promise<void>;
  manifestPath: string;
  signerPath: string;
};

async function runLocalAuthenticodeCommand(input: {
  brokerPath: string;
  helperPath: string;
  signerPath: string;
  subject: string;
}): Promise<NativeRuntimePublisherIdentity> {
  const child = spawn(
    input.signerPath,
    ['--subject', input.subject, '--artifact', input.helperPath, '--artifact', input.brokerPath],
    {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 60_000);
  const [exitCode] = await once(child, 'close').finally(() => clearTimeout(timeout));
  if (timedOut) {
    throw new Error('Local Authenticode signing timed out');
  }
  if (exitCode !== 0) {
    const detail = Buffer.concat(stderr).toString('utf8').trim();
    throw new Error(
      `Local Authenticode signing failed with exit code ${String(exitCode)}${detail ? `: ${detail}` : ''}`
    );
  }
  let result: { certificateSha256?: unknown; subject?: unknown };
  try {
    result = JSON.parse(Buffer.concat(stdout).toString('utf8')) as {
      certificateSha256?: unknown;
      subject?: unknown;
    };
  } catch {
    throw new Error('Local Authenticode signing returned an invalid result');
  }
  if (
    typeof result.certificateSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(result.certificateSha256)
  ) {
    throw new Error('Local Authenticode signing returned an invalid certificate SHA-256');
  }
  if (result.subject !== input.subject) {
    throw new Error('Local Authenticode signing returned an unexpected certificate subject');
  }
  return {
    certificateSha256: result.certificateSha256,
    subject: result.subject,
  };
}

async function verifyLocalAuthenticodeCommand(input: {
  certificateSha256: string;
  executablePath: string;
  signerPath: string;
  subject: string;
  trustMode: NativeRuntimePublisherTrustMode;
}): Promise<void> {
  if (input.trustMode !== 'pinned-development') {
    throw new Error('The local Authenticode verifier requires pinned development trust');
  }
  const child = spawn(
    input.signerPath,
    [
      '--verify',
      '--certificate-sha256',
      input.certificateSha256,
      '--subject',
      input.subject,
      '--artifact',
      input.executablePath,
    ],
    {
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    }
  );
  const stderr: Buffer[] = [];
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 60_000);
  const [exitCode] = await once(child, 'close').finally(() => clearTimeout(timeout));
  if (timedOut) {
    throw new Error('Local Authenticode verification timed out');
  }
  if (exitCode !== 0) {
    const detail = Buffer.concat(stderr).toString('utf8').trim();
    throw new Error(
      `Local Authenticode verification failed with exit code ${String(exitCode)}${detail ? `: ${detail}` : ''}`
    );
  }
}

async function prepareLocalNativeRuntimeRelease(input: {
  brokerPath: string;
  helperPath: string;
  metadataUrl: string;
  releasePath: string;
  runId: string;
  signerPath: string;
  targetsUrl: string;
  trustedRootPath: string;
}): Promise<LocalNativeRuntimeRelease> {
  const subject = `CN=YUCP Local Development ${input.runId}`;
  const publisher = await runLocalAuthenticodeCommand({
    brokerPath: input.brokerPath,
    helperPath: input.helperPath,
    signerPath: input.signerPath,
    subject,
  });
  const manifestPath = await createNativeRuntimeRelease({
    executablePath: input.helperPath,
    metadataUrl: input.metadataUrl,
    publisherInspector: async () => publisher,
    publisherTrustMode: 'pinned-development',
    releasePath: input.releasePath,
    targetsUrl: input.targetsUrl,
    trustedRootPath: input.trustedRootPath,
  });
  return {
    manifestPath,
    cleanup: () => Promise.resolve(),
    signerPath: input.signerPath,
  };
}

async function generateLocalTufRepository(input: {
  apiBaseUrl: string;
  authBaseUrl: string;
  baseEnv: NodeJS.ProcessEnv;
  installKeyId: string;
  installPublicKey: string;
  outputRoot: string;
  receiptKeyId: string;
  receiptPublicKey: string;
  runId: string;
}): Promise<LocalNativeRuntimeRelease> {
  const configuredGo = input.baseEnv.YUCP_GO_EXECUTABLE?.trim();
  const workspaceGo = 'E:\\YUCPTools\\go-1.26.5\\go\\bin\\go.exe';
  const goExecutable = configuredGo || (existsSync(workspaceGo) ? workspaceGo : 'go');
  const helperRoot = path.join(ROOT_DIR, 'Verify', 'Native', 'transfer-helper');
  const pinnedRoot = path.join(helperRoot, 'internal', 'tufclient', 'testdata', '1.root.json');
  const helperExecutable = path.join(path.dirname(input.outputRoot), 'yucp-transfer-helper.exe');
  const brokerExecutable = path.join(path.dirname(input.outputRoot), 'yucp-package-broker.exe');
  const signerExecutable = path.join(
    path.dirname(input.outputRoot),
    process.platform === 'win32'
      ? 'yucp-local-authenticode-sign.exe'
      : 'yucp-local-authenticode-sign'
  );
  const runGo = async (
    args: string[],
    failureLabel: string,
    envOverrides: NodeJS.ProcessEnv = {}
  ): Promise<void> => {
    const child = spawn(goExecutable, args, {
      cwd: helperRoot,
      env: { ...input.baseEnv, ...envOverrides },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    const stderr: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    const [exitCode] = await once(child, 'close');
    if (exitCode !== 0) {
      const detail = Buffer.concat(stderr).toString('utf8').trim();
      throw new Error(
        `${failureLabel} failed with exit code ${String(exitCode)}${detail ? `: ${detail}` : ''}`
      );
    }
  };
  await runGo(
    ['build', '-trimpath', '-ldflags=-s -w', '-o', helperExecutable, './cmd/yucp-transfer-helper'],
    'Local transfer-helper build',
    { CGO_ENABLED: '0', GOARCH: 'amd64', GOOS: 'windows' }
  );
  await runGo(
    ['build', '-trimpath', '-ldflags=-s -w', '-o', brokerExecutable, './cmd/yucp-package-broker'],
    'Local package-broker build',
    { CGO_ENABLED: '0', GOARCH: 'amd64', GOOS: 'windows' }
  );
  await runGo(
    [
      'build',
      '-trimpath',
      '-ldflags=-s -w',
      '-o',
      signerExecutable,
      './cmd/yucp-local-authenticode-sign',
    ],
    'Local Authenticode signer build',
    { CGO_ENABLED: '0' }
  );
  const nativeRuntimeRelease = await prepareLocalNativeRuntimeRelease({
    brokerPath: brokerExecutable,
    helperPath: helperExecutable,
    metadataUrl: `${input.apiBaseUrl}/api/v2/package-installer/tuf/metadata`,
    releasePath: path.dirname(input.outputRoot),
    runId: input.runId,
    signerPath: signerExecutable,
    targetsUrl: `${input.apiBaseUrl}/api/v2/package-installer/tuf/targets`,
    trustedRootPath: pinnedRoot,
  });
  try {
    await runGo(
      [
        'run',
        './cmd/yucp-local-tuf-repository',
        '--output',
        input.outputRoot,
        '--root',
        pinnedRoot,
        '--helper',
        helperExecutable,
        '--broker',
        brokerExecutable,
        '--api-base-url',
        input.apiBaseUrl,
        '--auth-base-url',
        input.authBaseUrl,
        '--metadata-url',
        `${input.apiBaseUrl}/api/v2/package-installer/tuf/metadata`,
        '--targets-url',
        `${input.apiBaseUrl}/api/v2/package-installer/tuf/targets`,
        '--metadata-version',
        String(Date.now()),
        '--install-key-id',
        input.installKeyId,
        '--install-public-key',
        input.installPublicKey,
        '--receipt-key-id',
        input.receiptKeyId,
        '--receipt-public-key',
        input.receiptPublicKey,
      ],
      'Local TUF repository generation'
    );
    return nativeRuntimeRelease;
  } catch (error) {
    await nativeRuntimeRelease.cleanup().catch(() => undefined);
    throw error;
  }
}

function buildShellCommand(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      file: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', command],
    };
  }

  return {
    file: '/bin/sh',
    args: ['-lc', command],
  };
}

function buildPrefix(name: string, color: PrefixColor): string {
  return `${PREFIX_COLORS[color]}[${name}]${PREFIX_RESET} `;
}

function isCommandRequired(spec: DevCommandSpec): boolean {
  return spec.required ?? true;
}

function forwardPrefixedOutput(
  stream: NodeJS.ReadableStream | null,
  writer: NodeJS.WritableStream,
  prefix: string
): void {
  if (!stream) {
    return;
  }

  const readable = stream as NodeJS.ReadableStream & {
    setEncoding?(encoding: BufferEncoding): void;
  };
  readable.setEncoding?.('utf8');

  let buffer = '';
  readable.on('data', (chunk: string | Buffer) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      writer.write(`${prefix}${line}\n`);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
    }
  });
  readable.on('end', () => {
    const trailing = buffer.replace(/\r$/, '');
    if (trailing.length > 0) {
      writer.write(`${prefix}${trailing}\n`);
    }
  });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ESRCH' || error.code === 'EINVAL')
    ) {
      return false;
    }
    return true;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(100);
  }

  return !isProcessAlive(pid);
}

function isMissingProcessError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const details = [
    'stdout' in error ? error.stdout : '',
    'stderr' in error ? error.stderr : '',
    'message' in error ? error.message : '',
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n')
    .toLowerCase();

  return (
    details.includes('not found') ||
    details.includes('no running instance') ||
    details.includes('no process found')
  );
}

async function killWindowsProcessTreeWithPowershell(pid: number): Promise<void> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$rootPid = ${pid}
$processes = Get-Process
function Stop-ProcessTree([int]$currentPid) {
  foreach ($child in $processes) {
    try {
      if ($null -ne $child.Parent -and $child.Parent.Id -eq $currentPid) {
        Stop-ProcessTree $child.Id
      }
    } catch {
    }
  }
  Stop-Process -Id $currentPid -Force -ErrorAction SilentlyContinue
}
Stop-ProcessTree $rootPid
`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: WINDOWS_POWERSHELL_KILL_TIMEOUT_MS,
    windowsHide: true,
  });
}

export async function killProcessTree(
  pid: number,
  signal: NodeJS.Signals = 'SIGINT'
): Promise<void> {
  if (!isProcessAlive(pid)) {
    return;
  }

  if (process.platform === 'win32') {
    let taskkillError: unknown;
    try {
      await execFileAsync('taskkill', ['/pid', `${pid}`, '/t', '/f'], {
        timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch (error) {
      if (!isProcessAlive(pid) || isMissingProcessError(error)) {
        return;
      }
      taskkillError = error;
      try {
        await killWindowsProcessTreeWithPowershell(pid);
      } catch (fallbackError) {
        if (!isProcessAlive(pid) || isMissingProcessError(fallbackError)) {
          return;
        }
        throw fallbackError;
      }
    }
    if (await waitForProcessExit(pid, 5_000)) {
      return;
    }
    if (taskkillError) {
      throw taskkillError;
    }
    return;
  }

  const targets = [-pid, pid];
  for (const currentSignal of [signal, 'SIGTERM', 'SIGKILL'] as const) {
    for (const target of targets) {
      try {
        process.kill(target, currentSignal);
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          (error.code === 'ESRCH' || error.code === 'EINVAL')
        ) {
          // The process or group is already gone. Keep checking the remaining targets.
        }
      }
    }

    if (await waitForProcessExit(pid, currentSignal === 'SIGKILL' ? 1_000 : 2_000)) {
      return;
    }
  }
}

class ManagedCommand {
  readonly child: ChildProcess;
  readonly closePromise: Promise<number | null>;

  constructor(
    readonly spec: DevCommandSpec,
    baseEnv: NodeJS.ProcessEnv,
    options: Required<DevSupervisorOptions>
  ) {
    const shell = buildShellCommand(spec.command);
    this.child = spawn(shell.file, shell.args, {
      cwd: spec.cwd ?? ROOT_DIR,
      env: {
        ...baseEnv,
        ...spec.env,
      },
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    const prefix = buildPrefix(spec.name, spec.color);
    if (options.prefixOutput) {
      forwardPrefixedOutput(this.child.stdout, process.stdout, prefix);
      forwardPrefixedOutput(this.child.stderr, process.stderr, prefix);
    }

    this.closePromise = new Promise((resolve) => {
      this.child.once('close', (code) => resolve(code));
    });
  }

  async stop(signal: NodeJS.Signals): Promise<void> {
    if (this.child.exitCode !== null || this.child.pid == null) {
      return;
    }

    await killProcessTree(this.child.pid, signal);
    await Promise.race([this.closePromise, sleep(5_000)]);
  }
}

export class DevSupervisor {
  private readonly managed: ManagedCommand[] = [];
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly commands: readonly DevCommandSpec[],
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
    private readonly options: Required<DevSupervisorOptions> = {
      prefixOutput: true,
    }
  ) {}

  async start(): Promise<void> {
    for (const spec of this.commands) {
      this.managed.push(new ManagedCommand(spec, this.baseEnv, this.options));
    }
  }

  async shutdown(signal: NodeJS.Signals = 'SIGINT'): Promise<void> {
    if (this.shutdownPromise) {
      await this.shutdownPromise;
      return;
    }

    this.shutdownPromise = Promise.all(this.managed.map((command) => command.stop(signal))).then(
      () => undefined
    );
    await this.shutdownPromise;
  }

  async waitForExit(): Promise<number> {
    const remaining = [...this.managed];
    while (remaining.length > 0) {
      const firstExit = await Promise.race(
        remaining.map(async (command) => ({
          command,
          code: await command.closePromise,
        }))
      );
      const exitCode = firstExit.code ?? 0;
      const exitedIndex = remaining.indexOf(firstExit.command);
      if (exitedIndex >= 0) {
        remaining.splice(exitedIndex, 1);
      }

      if (!isCommandRequired(firstExit.command.spec)) {
        if (!this.shutdownPromise) {
          const prefix = buildPrefix('dev', 'yellow');
          process.stderr.write(
            `${prefix}Optional dev helper ${firstExit.command.spec.name} exited with code ${exitCode}. Keeping the main dev processes running.\n`
          );
        }
        continue;
      }

      if (!this.shutdownPromise) {
        const prefix = buildPrefix('dev', 'magenta');
        process.stderr.write(
          `${prefix}${firstExit.command.spec.name} exited with code ${exitCode}. Shutting down the remaining dev processes.\n`
        );
        await this.shutdown(exitCode === 0 ? 'SIGTERM' : 'SIGINT');
      }

      return exitCode;
    }

    return 0;
  }
}

async function runCommandStep(step: DevCommandSpec, env: NodeJS.ProcessEnv): Promise<void> {
  const shell = buildShellCommand(step.command);
  const child = spawn(shell.file, shell.args, {
    cwd: step.cwd ?? ROOT_DIR,
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const prefix = buildPrefix(step.name, step.color);
  forwardPrefixedOutput(child.stdout, process.stdout, prefix);
  forwardPrefixedOutput(child.stderr, process.stderr, prefix);

  const [code] = await once(child, 'close');
  if (typeof code === 'number' && code !== 0) {
    throw new Error(`${step.name} exited with code ${code}`);
  }
}

export function applyLocalDevDefaults(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const preferRemoteHyperdx = baseEnv[DEV_HYPERDX_USE_REMOTE_FLAG] === 'true';
  return {
    ...baseEnv,
    FRONTEND_URL: baseEnv.FRONTEND_URL ?? DEV_FRONTEND_URL,
    HYPERDX_APP_URL: preferRemoteHyperdx
      ? (baseEnv.HYPERDX_APP_URL ?? DEV_HYPERDX_APP_URL)
      : DEV_HYPERDX_APP_URL,
    HYPERDX_OTLP_HTTP_URL: preferRemoteHyperdx
      ? (baseEnv.HYPERDX_OTLP_HTTP_URL ?? DEV_HYPERDX_OTLP_HTTP_URL)
      : DEV_HYPERDX_OTLP_HTTP_URL,
    HYPERDX_OTLP_GRPC_URL: preferRemoteHyperdx
      ? (baseEnv.HYPERDX_OTLP_GRPC_URL ?? DEV_HYPERDX_OTLP_GRPC_URL)
      : DEV_HYPERDX_OTLP_GRPC_URL,
    OTEL_EXPORTER_OTLP_ENDPOINT: preferRemoteHyperdx
      ? (baseEnv.OTEL_EXPORTER_OTLP_ENDPOINT ??
        baseEnv.HYPERDX_OTLP_HTTP_URL ??
        DEV_HYPERDX_OTLP_HTTP_URL)
      : DEV_HYPERDX_OTLP_HTTP_URL,
    OTEL_EXPORTER_OTLP_PROTOCOL: baseEnv.OTEL_EXPORTER_OTLP_PROTOCOL ?? 'http/protobuf',
  };
}

export function applyInfisicalDevSecrets(
  bootstrapEnv: NodeJS.ProcessEnv,
  secrets: Record<string, string>
): NodeJS.ProcessEnv {
  return applyLocalDevDefaults({
    ...bootstrapEnv,
    ...secrets,
    FRONTEND_URL: DEV_FRONTEND_URL,
  });
}

export function applyLocalStorageProfile(
  baseEnv: NodeJS.ProcessEnv,
  storage: DisposableStorageHarness | InteractiveStorageHarness,
  secrets: {
    couplingServiceSharedSecret: string;
    installSigningKeyId: string;
    installSigningPrivateKey: string;
    installSigningPublicKey: string;
    materializationApiSharedSecret: string;
    materializationCapabilityKeyId: string;
    materializationCapabilityPrivateKey: string;
    materializationCapabilityPublicKey: string;
    materializationKeyBrokerSharedSecret: string;
    materializationMaterializerSharedSecret: string;
    materializationReceiptKeyId: string;
    materializationReceiptPrivateKey: string;
    materializationReceiptPublicKey: string;
    materializationSourceGrantKeyId: string;
    materializationSourceGrantPrivateKey: string;
    materializationSourceGrantPublicKey: string;
    packageCatalogControlSharedSecret: string;
    uploadHmacKey: string;
  },
  ports: DevPortSet = DEFAULT_DEV_PORTS,
  storageProfile: 'disposable' | 'interactive' = 'disposable'
): NodeJS.ProcessEnv {
  const webUrl = `http://localhost:${ports.web}`;
  const apiUrl = `http://127.0.0.1:${ports.api}`;
  const ingestUrl = `http://localhost:${ports.ingest}`;
  const deliveryUrl = `http://127.0.0.1:${ports.delivery}`;
  const publicVpmUrl = `http://127.0.0.1:${ports.publicVpm}`;
  const materializationControlUrl = `http://127.0.0.1:${ports.materializationControl}`;
  const materializationSourceUrl = `http://127.0.0.1:${ports.materializationSource}`;
  const couplingUrl = `http://127.0.0.1:${ports.coupling}`;
  const storageRoleEnvironment = Object.fromEntries(
    Object.entries(storage.buckets).flatMap(([role, config]) => {
      const prefix = role === 'renditions' ? 'RENDITION' : role.toUpperCase();
      return [
        [`${prefix}_S3_ACCESS_KEY_ID`, config.accessKeyId],
        [`${prefix}_S3_BUCKET`, config.bucket],
        [`${prefix}_S3_ENDPOINT`, config.endpoint],
        [`${prefix}_S3_REGION`, config.region],
        [`${prefix}_S3_SECRET_ACCESS_KEY`, config.secretAccessKey],
      ];
    })
  );
  return {
    ...baseEnv,
    ...storageRoleEnvironment,
    COMMON_CHUNK_PREFIX: storage.buckets.common.chunkPrefix,
    METADATA_INDEX_PREFIX: storage.buckets.metadata.indexPrefix,
    PROTECTED_CHUNK_PREFIX: storage.buckets.protected.chunkPrefix,
    CATALOG_DATABASE_URL: storage.postgres.url,
    PACKAGE_CATALOG_DATABASE_URL: storage.postgres.url,
    VPM_ALIAS_PUBLICATION_CATALOG_DATABASE_URL: storage.postgres.url,
    PACKAGE_OPERATION_AUTHORIZATION_DATABASE_URL: storage.postgres.url,
    FRONTEND_URL: webUrl,
    HYPERDX_APP_URL: `http://127.0.0.1:${ports.hyperdxApp}`,
    HYPERDX_DEV_CONTAINER_NAME: `yucp-hyperdx-${storage.runId}`,
    HYPERDX_OTLP_GRPC_URL: `127.0.0.1:${ports.hyperdxOtlpGrpc}`,
    HYPERDX_OTLP_HTTP_URL: `http://127.0.0.1:${ports.hyperdxOtlpHttp}`,
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${ports.hyperdxOtlpHttp}`,
    SITE_URL: webUrl,
    PACKAGE_CATALOG_CONTROL_INTERNAL_BASE_URL: ingestUrl,
    PACKAGE_CATALOG_CONTROL_SHARED_SECRET: secrets.packageCatalogControlSharedSecret,
    MATERIALIZATION_ALGORITHM_VERSION:
      baseEnv.MATERIALIZATION_ALGORITHM_VERSION ?? 'png-dct-qim-v2',
    MATERIALIZATION_API_SHARED_SECRET: secrets.materializationApiSharedSecret,
    MATERIALIZATION_CAPABILITY_KEY_ID: secrets.materializationCapabilityKeyId,
    MATERIALIZATION_CAPABILITY_LIFETIME_SECONDS: '300',
    MATERIALIZATION_CAPABILITY_PRIVATE_KEY: secrets.materializationCapabilityPrivateKey,
    MATERIALIZATION_CAPABILITY_PUBLIC_KEY: secrets.materializationCapabilityPublicKey,
    MATERIALIZATION_CONTROL_PLANE_INTERNAL_BASE_URL: materializationControlUrl,
    MATERIALIZATION_CONTROL_PLANE_PUBLIC_BASE_URL: materializationControlUrl,
    MATERIALIZATION_KEY_EPOCH: baseEnv.MATERIALIZATION_KEY_EPOCH ?? '1',
    MATERIALIZATION_KEY_BROKER_BASE_URL: couplingUrl,
    MATERIALIZATION_KEY_BROKER_SHARED_SECRET: secrets.materializationKeyBrokerSharedSecret,
    MATERIALIZATION_MATERIALIZER_SHARED_SECRET:
      baseEnv.MATERIALIZATION_MATERIALIZER_SHARED_SECRET ??
      secrets.materializationMaterializerSharedSecret,
    MATERIALIZATION_PLUGIN_VERSION: baseEnv.MATERIALIZATION_PLUGIN_VERSION ?? 'coupling-server-v3',
    MATERIALIZATION_RECEIPT_KEY_ID: secrets.materializationReceiptKeyId,
    MATERIALIZATION_RECEIPT_PRIVATE_KEY: secrets.materializationReceiptPrivateKey,
    MATERIALIZATION_RECEIPT_PUBLIC_KEY: secrets.materializationReceiptPublicKey,
    MATERIALIZATION_SOURCE_DELIVERY_BASE_URL: materializationSourceUrl,
    MATERIALIZATION_SOURCE_GRANT_AUDIENCE: materializationSourceUrl,
    MATERIALIZATION_SOURCE_GRANT_ISSUER: materializationControlUrl,
    MATERIALIZATION_SOURCE_GRANT_KEY_ID: secrets.materializationSourceGrantKeyId,
    MATERIALIZATION_SOURCE_GRANT_PRIVATE_KEY: secrets.materializationSourceGrantPrivateKey,
    MATERIALIZATION_SOURCE_GRANT_PUBLIC_KEY: secrets.materializationSourceGrantPublicKey,
    PACKAGE_DELIVERY_AUDIENCE: deliveryUrl,
    PACKAGE_INSTALL_ISSUER: apiUrl,
    PACKAGE_INSTALL_SIGNING_KEY_ID: secrets.installSigningKeyId,
    PACKAGE_INSTALL_SIGNING_PRIVATE_KEY: secrets.installSigningPrivateKey,
    PACKAGE_INSTALL_SIGNING_PUBLIC_KEY: secrets.installSigningPublicKey,
    INGEST_ALLOWED_ORIGIN: webUrl,
    INGEST_MAX_BYTES: String(DEV_MAX_UPLOAD_BYTES),
    INGEST_SCRATCH_DIR: storage.scratchRoot,
    INGEST_TUS_URL: ingestUrl,
    INGEST_UPLOAD_DIR: storage.uploadDir,
    NODE_ENV: baseEnv.NODE_ENV ?? 'development',
    UPLOAD_HMAC_KEY: secrets.uploadHmacKey,
    VPM_BASE_URL: apiUrl,
    VPM_PUBLIC_INDEX_URL: `${publicVpmUrl}/index.json`,
    YUCP_COUPLING_SERVICE_BASE_URL: couplingUrl,
    YUCP_COUPLING_SERVICE_SHARED_SECRET: secrets.couplingServiceSharedSecret,
    ...(storageProfile === 'disposable' ? { YUCP_DISPOSABLE_RUN_ID: storage.runId } : {}),
    YUCP_STORAGE_EPOCH: storage.runId,
    YUCP_STORAGE_PROFILE: storageProfile,
  };
}

async function loadInfisicalEnv(): Promise<NodeJS.ProcessEnv> {
  const localEnvFilePath = path.join(ROOT_DIR, '.env.local');
  const localEnvFile = existsSync(localEnvFilePath) ? await readFile(localEnvFilePath, 'utf8') : '';
  const envFilePath = path.join(ROOT_DIR, '.env.infisical');
  const envFile = existsSync(envFilePath) ? await readFile(envFilePath, 'utf8') : '';
  const bootstrapEnv = {
    ...process.env,
    ...parseDotenv(localEnvFile),
    ...parseDotenv(envFile),
  };
  const secrets = await fetchInfisicalSecrets(bootstrapEnv);
  if (Object.keys(secrets).length === 0) {
    throw new Error('Infisical returned no secrets for the development supervisor');
  }
  return applyInfisicalDevSecrets(bootstrapEnv, secrets);
}

async function loadLocalEnv(): Promise<NodeJS.ProcessEnv> {
  const envFilePath = path.join(ROOT_DIR, '.env.local');
  const envFile = existsSync(envFilePath) ? await readFile(envFilePath, 'utf8') : '';
  process.stderr.write(
    `${buildPrefix('dev', 'yellow')}Infisical is not enabled for this dev run; using process.env and .env.local fallback values only.\n`
  );
  return applyLocalDevDefaults({
    ...process.env,
    ...parseDotenv(envFile),
  });
}

function signalExitCode(signal: NodeJS.Signals): number {
  return signal === 'SIGINT' ? 130 : 143;
}

async function removeOwnedDockerResource(args: string[]): Promise<void> {
  try {
    await execFileAsync('docker', args, {
      timeout: 30_000,
      windowsHide: true,
    });
  } catch (error) {
    const details =
      error && typeof error === 'object'
        ? ['message', 'stderr', 'stdout']
            .flatMap((key) => {
              const value = key in error ? error[key as keyof typeof error] : undefined;
              return typeof value === 'string' || Buffer.isBuffer(value) ? [String(value)] : [];
            })
            .join('\n')
            .toLowerCase()
        : String(error).toLowerCase();
    if (details.includes('no such container') || details.includes('no such volume')) {
      return;
    }
    throw error;
  }
}

export async function cleanupDisposableHyperdxResources(containerName: string): Promise<void> {
  if (!/^yucp-hyperdx-[0-9a-f]{12}$/.test(containerName)) {
    throw new Error('Refusing to clean a HyperDX resource outside a disposable runtime');
  }
  await removeOwnedDockerResource(['rm', '--force', containerName]);
  for (const volume of [
    `${containerName}-db`,
    `${containerName}-ch-data`,
    `${containerName}-ch-logs`,
  ]) {
    await removeOwnedDockerResource(['volume', 'rm', '--force', volume]);
  }
}

export async function rethrowAfterOwnedCleanup(
  startupError: unknown,
  ownsResource: boolean,
  cleanup: () => Promise<void>
): Promise<never> {
  if (!ownsResource) {
    throw startupError;
  }
  try {
    await cleanup();
  } catch (cleanupError) {
    throw new AggregateError(
      [startupError, cleanupError],
      'Owned dependency startup and cleanup failed'
    );
  }
  throw startupError;
}

export function resolveDevCliOptions(argv: readonly string[]): {
  infisical: boolean;
} {
  if (argv.length === 0) {
    return { infisical: false };
  }
  if (argv.length === 1 && argv[0] === 'infisical') {
    return { infisical: true };
  }
  throw new Error('Usage: bun dev [infisical]');
}

async function startDevRuntime(
  options: StartDisposableDevRuntimeOptions,
  storageProfile: 'disposable' | 'interactive'
): Promise<DevRuntime> {
  const infisical = options.infisical ?? false;
  const ports = options.ports ?? DEFAULT_DEV_PORTS;
  const configuredImporterPackagePath = options.importerPackagePath?.trim();
  if (
    options.importerPackagePath !== undefined &&
    (!configuredImporterPackagePath || !path.isAbsolute(configuredImporterPackagePath))
  ) {
    throw new Error('The development importer package path must be absolute');
  }
  let loadedEnv = infisical ? await loadInfisicalEnv() : await loadLocalEnv();
  const convexProfile = options.convexProfile ?? 'development';
  let convex:
    | {
        adminKey: string;
        backendUrl: string;
        siteUrl: string;
      }
    | undefined;
  let ownsSelfHostedConvex = false;
  let selfHostedConvexProfile: SelfHostedConvexProfile | undefined;
  if (convexProfile === 'self-hosted') {
    selfHostedConvexProfile = {
      backendPort: ports.convexBackend,
      dashboardPort: ports.convexDashboard,
      projectName: `yucp-lifecycle-${randomBytes(6).toString('hex')}`,
      sitePort: ports.convexSite,
    };
    ownsSelfHostedConvex = !(await isRealBackendHealthy(selfHostedConvexProfile));
    try {
      await ensureRealBackendUp(selfHostedConvexProfile, {
        betterAuthAdditionalTrustedOrigins: options.betterAuthAdditionalTrustedOrigins,
      });
      const adminKey = await getRealBackendAdminKey(selfHostedConvexProfile);
      const cliEnvironment = selfHostedConvexEnv(adminKey, selfHostedConvexProfile);
      await enableRealBackendTestHelpers(adminKey, selfHostedConvexProfile);
      ensureConvexDependenciesResolvable();
      await withSelfHostedConvexEnvFileMovedAside(() =>
        runSelfHostedConvexCli(['deploy', '-y'], cliEnvironment)
      );
      convex = {
        adminKey,
        backendUrl: `http://127.0.0.1:${ports.convexBackend}`,
        siteUrl: `http://127.0.0.1:${ports.convexSite}`,
      };
      loadedEnv = {
        ...loadedEnv,
        BETTER_AUTH_SECRET: SELF_HOSTED_BETTER_AUTH_SECRET,
        BETTER_AUTH_URL: `http://127.0.0.1:${ports.convexSite}/api/auth`,
        CONVEX_API_SECRET: SELF_HOSTED_CONVEX_API_SECRET,
        CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
        CONVEX_SITE_URL: `http://127.0.0.1:${ports.convexSite}`,
        CONVEX_URL: `http://127.0.0.1:${ports.convexBackend}`,
        ENCRYPTION_SECRET: SELF_HOSTED_ENCRYPTION_SECRET,
        INTERNAL_SERVICE_AUTH_SECRET: SELF_HOSTED_INTERNAL_SERVICE_AUTH_SECRET,
      };
      delete loadedEnv.CONVEX_DEPLOYMENT;
      delete loadedEnv.CONVEX_DEPLOYMENT_PROD;
      delete loadedEnv.CONVEX_DEPLOY_KEY;
      delete loadedEnv.CONVEX_DEPLOY_KEY_PROD;
    } catch (error) {
      await rethrowAfterOwnedCleanup(error, ownsSelfHostedConvex, () =>
        stopRealBackend(selfHostedConvexProfile)
      );
    }
  }
  let storage: DisposableStorageHarness | InteractiveStorageHarness;
  try {
    storage =
      storageProfile === 'interactive'
        ? await startInteractiveStorageHarness()
        : await startDisposableStorageHarness();
  } catch (error) {
    if (ownsSelfHostedConvex) {
      await stopRealBackend(selfHostedConvexProfile);
    }
    throw error;
  }

  let localNativeRuntimeRelease: LocalNativeRuntimeRelease | undefined;
  try {
    const stableSecrets = interactiveRuntimeSecrets(storage);
    const installSigningPrivateKey = stableSecrets
      ? Buffer.from(stableSecrets.installSigningPrivateKey, 'base64url')
      : randomBytes(32);
    const materializationCapabilityPrivateKey = stableSecrets
      ? Buffer.from(stableSecrets.materializationCapabilityPrivateKey, 'base64url')
      : randomBytes(32);
    const materializationReceiptPrivateKey = stableSecrets
      ? Buffer.from(stableSecrets.materializationReceiptPrivateKey, 'base64url')
      : randomBytes(32);
    const materializationSourceGrantPrivateKey = stableSecrets
      ? Buffer.from(stableSecrets.materializationSourceGrantPrivateKey, 'base64url')
      : randomBytes(32);
    const installSigningKeyId = `local-${storage.runId}`;
    const materializationReceiptKeyId = `local-receipt-${storage.runId}`;
    const installSigningPublicKey = Buffer.from(
      await ed25519.getPublicKeyAsync(installSigningPrivateKey)
    ).toString('base64url');
    const materializationReceiptPublicKey = Buffer.from(
      await ed25519.getPublicKeyAsync(materializationReceiptPrivateKey)
    ).toString('base64url');
    const tufRepositoryRoot = path.join(path.dirname(storage.uploadDir), 'package-installer-tuf');
    const packageRuntimeAuthBaseUrl = resolvePackageRuntimeAuthBaseUrl(
      loadedEnv,
      options.packageRuntimeAuthBaseUrl
    );
    localNativeRuntimeRelease = await generateLocalTufRepository({
      apiBaseUrl: `http://127.0.0.1:${ports.api}`,
      authBaseUrl: packageRuntimeAuthBaseUrl,
      baseEnv: loadedEnv,
      installKeyId: installSigningKeyId,
      installPublicKey: installSigningPublicKey,
      outputRoot: tufRepositoryRoot,
      receiptKeyId: materializationReceiptKeyId,
      receiptPublicKey: materializationReceiptPublicKey,
      runId: storage.runId,
    });
    const nativeRuntimeRelease = localNativeRuntimeRelease;
    const localImporterRepository = await buildLocalImporterRepository({
      baseUrl: `http://127.0.0.1:${ports.publicVpm}`,
      importerPath:
        configuredImporterPackagePath ?? (await resolveLocalImporterPackagePath(loadedEnv)),
      nativeRuntimeRelease: await readNativeRuntimeReleaseManifest(
        nativeRuntimeRelease.manifestPath,
        (publisher) =>
          verifyLocalAuthenticodeCommand({
            ...publisher,
            signerPath: nativeRuntimeRelease.signerPath,
          })
      ),
    });
    const env = applyLocalStorageProfile(
      {
        ...loadedEnv,
        PACKAGE_INSTALLER_TUF_REPOSITORY_ROOT: tufRepositoryRoot,
        VPM_IMPORTER_RELEASE_LEDGER_JSON: JSON.stringify(
          buildLocalImporterReleaseLedger(localImporterRepository)
        ),
        YUCP_IMPORTER_NATIVE_RUNTIME_RELEASE_MANIFEST: nativeRuntimeRelease.manifestPath,
      },
      storage,
      {
        couplingServiceSharedSecret:
          stableSecrets?.couplingServiceSharedSecret ?? randomBytes(32).toString('base64url'),
        installSigningKeyId,
        installSigningPrivateKey: installSigningPrivateKey.toString('base64url'),
        installSigningPublicKey,
        materializationApiSharedSecret:
          stableSecrets?.materializationApiSharedSecret ?? randomBytes(32).toString('base64url'),
        materializationCapabilityKeyId: `local-capability-${storage.runId}`,
        materializationCapabilityPrivateKey:
          materializationCapabilityPrivateKey.toString('base64url'),
        materializationCapabilityPublicKey: Buffer.from(
          await ed25519.getPublicKeyAsync(materializationCapabilityPrivateKey)
        ).toString('base64url'),
        materializationKeyBrokerSharedSecret:
          stableSecrets?.materializationKeyBrokerSharedSecret ??
          randomBytes(32).toString('base64url'),
        materializationMaterializerSharedSecret:
          stableSecrets?.materializationMaterializerSharedSecret ??
          randomBytes(32).toString('base64url'),
        materializationReceiptKeyId,
        materializationReceiptPrivateKey: materializationReceiptPrivateKey.toString('base64url'),
        materializationReceiptPublicKey,
        materializationSourceGrantKeyId: `local-source-grant-${storage.runId}`,
        materializationSourceGrantPrivateKey:
          materializationSourceGrantPrivateKey.toString('base64url'),
        materializationSourceGrantPublicKey: Buffer.from(
          await ed25519.getPublicKeyAsync(materializationSourceGrantPrivateKey)
        ).toString('base64url'),
        packageCatalogControlSharedSecret:
          stableSecrets?.packageCatalogControlSharedSecret ?? randomBytes(32).toString('base64url'),
        uploadHmacKey: stableSecrets?.uploadHmacKey ?? randomBytes(32).toString('base64url'),
      },
      ports,
      storageProfile
    );
    const defaultCommands = buildDevCommands(
      env,
      infisical && convexProfile === 'development',
      ports
    ).filter((command) => convexProfile !== 'self-hosted' || command.name !== 'convex');
    const supervisor = new DevSupervisor(options.commands ?? defaultCommands, env, {
      prefixOutput: options.prefixOutput ?? true,
    });
    process.stderr.write(
      `${buildPrefix('storage', 'cyan')}${storageProfile === 'interactive' ? 'Persistent interactive' : 'Disposable'} PostgreSQL and five-bucket MinIO profile ${storage.runId} is ready.\n`
    );
    if (infisical && convexProfile !== 'self-hosted') {
      await runCommandStep(
        {
          name: 'sync',
          color: 'magenta',
          command: 'bun run sync:convex:env',
        },
        env
      );
    }

    await supervisor.start();
    let stopPromise: Promise<void> | undefined;
    const stop = async (signal: NodeJS.Signals = 'SIGINT'): Promise<void> => {
      if (!stopPromise) {
        stopPromise = (async () => {
          const failures: unknown[] = [];
          try {
            await supervisor.shutdown(signal);
          } catch (error) {
            failures.push(error);
          }
          try {
            await localNativeRuntimeRelease?.cleanup();
          } catch (error) {
            failures.push(error);
          }
          try {
            await cleanupDisposableHyperdxResources(
              env.HYPERDX_DEV_CONTAINER_NAME ?? `yucp-hyperdx-${storage.runId}`
            );
          } catch (error) {
            failures.push(error);
          }
          try {
            await storage.stop();
          } catch (error) {
            failures.push(error);
          }
          if (ownsSelfHostedConvex) {
            try {
              await stopRealBackend(selfHostedConvexProfile);
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length > 0) {
            throw new AggregateError(
              failures,
              `${storageProfile === 'interactive' ? 'Interactive' : 'Disposable'} development runtime cleanup failed`
            );
          }
        })();
      }
      await stopPromise;
    };
    return {
      convex,
      env,
      runId: storage.runId,
      storage,
      stop,
      supervisor,
      urls: {
        api: `http://127.0.0.1:${ports.api}`,
        coupling: `http://127.0.0.1:${ports.coupling}`,
        delivery: `http://127.0.0.1:${ports.delivery}`,
        ingest: `http://127.0.0.1:${ports.ingest}`,
        materializationControl: `http://127.0.0.1:${ports.materializationControl}`,
        materializationSource: `http://127.0.0.1:${ports.materializationSource}`,
        publicVpm: `http://127.0.0.1:${ports.publicVpm}`,
        web: `http://localhost:${ports.web}`,
      },
      waitUntilReady: async () => {
        await waitForDevHttpReadiness(buildDevReadinessEndpoints(ports));
      },
      waitForExit: async () => {
        const exitCode = await supervisor.waitForExit();
        await stop(exitCode === 0 ? 'SIGTERM' : 'SIGINT');
        return exitCode;
      },
    };
  } catch (error) {
    await localNativeRuntimeRelease?.cleanup().catch(() => undefined);
    await storage.stop();
    if (ownsSelfHostedConvex) {
      await stopRealBackend(selfHostedConvexProfile);
    }
    throw error;
  }
}

export async function startDisposableDevRuntime(
  options: StartDisposableDevRuntimeOptions = {}
): Promise<DevRuntime> {
  return startDevRuntime(options, 'disposable');
}

export async function startInteractiveDevRuntime(
  options: StartInteractiveDevRuntimeOptions = {}
): Promise<DevRuntime> {
  return startDevRuntime(options, 'interactive');
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const cliOptions = resolveDevCliOptions(argv);
  const runtime = await startInteractiveDevRuntime({
    infisical: cliOptions.infisical,
    prefixOutput: true,
  });
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await runtime.stop(signal);
    process.exit(signalExitCode(signal));
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  const exitCode = await runtime.waitForExit();
  process.exit(exitCode);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error('[dev]', error);
    process.exit(1);
  }
}
