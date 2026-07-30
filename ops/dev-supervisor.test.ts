import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  allocateDevPortSet,
  applyInfisicalDevSecrets,
  applyLocalDevDefaults,
  applyLocalStorageProfile,
  buildDevCommands,
  buildDevReadinessEndpoints,
  DEFAULT_DEV_PORTS,
  DevSupervisor,
  isProcessAlive,
  killProcessTree,
  resolveDevCliOptions,
  rethrowAfterOwnedCleanup,
  startDisposableDevRuntime,
  waitForDevHttpReadiness,
} from './dev-supervisor';
import { buildHyperdxDockerArgs, isDockerUnavailable } from './hyperdx-dev';
import { createLocalBetterAuthBootstrap } from './package-lifecycle/localBetterAuthBootstrap';
import { resolveResetEpoch } from './reset-interactive-storage';
import {
  type DisposableStorageHarness,
  POSTGRES_17_IMAGE,
} from './testing/disposableStorageHarness';

let importerFixturePath = '';
let importerFixtureRoot = '';

beforeAll(async () => {
  importerFixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'yucp-dev-supervisor-importer-'));
  const importerPath = path.join(importerFixtureRoot, 'com.yucp.importer');
  const trustSourceDirectory = path.join(importerPath, 'Editor', 'PackageManager', 'Core');
  await mkdir(trustSourceDirectory, { recursive: true });
  await writeFile(
    path.join(importerPath, 'package.json'),
    `${JSON.stringify({
      displayName: 'YUCP Importer Test Fixture',
      name: 'com.yucp.importer',
      version: '0.0.1',
    })}\n`
  );
  await writeFile(
    path.join(trustSourceDirectory, 'NativePackageRuntimeTrust.cs'),
    [
      'namespace YUCP.PackageManager.Core',
      '{',
      '    internal static class NativePackageRuntimeTrust',
      '    {',
      '        internal const string ExecutableSha256 = "";',
      '        internal const string MetadataUrl = "";',
      '        internal const string PublisherCertificateSha256 = "";',
      '        internal const string PublisherSubject = "";',
      '        internal const string PublisherTrustMode = "";',
      '        internal const string TargetsUrl = "";',
      '        internal const string TrustedRootSha256 = "";',
      '    }',
      '}',
      '',
    ].join('\n')
  );
  importerFixturePath = importerPath;
});

afterAll(async () => {
  if (importerFixtureRoot) {
    await rm(importerFixtureRoot, { force: true, recursive: true });
  }
});

function runDocker(args: string[]): { exitCode: number; stderr: string; stdout: string } {
  const result = Bun.spawnSync(['docker', ...args], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString('utf8'),
    stdout: result.stdout.toString('utf8'),
  };
}

async function waitFor<T>(
  load: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 10_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await load();
      if (predicate(value)) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('Timed out waiting for expected condition');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function storageRoleFixture(role: string) {
  return {
    accessKeyId: `local-${role}-key`,
    bucket: `local-${role}`,
    chunkPrefix: 'chunks/',
    endpoint: 'http://127.0.0.1:49152',
    indexPrefix: 'indexes/',
    region: 'us-east-1',
    requestTimeoutMs: 30_000,
    secretAccessKey: `local-${role}-secret`,
  };
}

describe('DevSupervisor', () => {
  test('bun dev infisical selects the Infisical runtime', () => {
    expect(resolveDevCliOptions(['infisical'])).toEqual({
      infisical: true,
    });
    expect(() => resolveDevCliOptions(['--infisical'])).toThrow('Usage: bun dev [infisical]');
  });

  test('the interactive storage reset requires an exact epoch confirmation', () => {
    expect(resolveResetEpoch(['--epoch', '123456789abc'])).toBe('123456789abc');
    expect(() => resolveResetEpoch([])).toThrow('Usage: bun run dev:storage:reset');
    expect(() => resolveResetEpoch(['--epoch', 'current'])).toThrow(
      'Usage: bun run dev:storage:reset'
    );
  });

  test('the disposable runtime owns exact storage and idempotent cleanup', async () => {
    const runtime = await startDisposableDevRuntime({
      commands: [],
      infisical: false,
      importerPackagePath: importerFixturePath,
      packageRuntimeAuthBaseUrl: 'http://127.0.0.1:3211/api/auth',
      prefixOutput: false,
    });
    const storageRoot = path.dirname(runtime.storage.uploadDir);
    const postgresContainer = runtime.storage.postgres.containerName;
    const minioContainer = runtime.storage.minio.containerName;

    expect(runtime.env.PACKAGE_CATALOG_DATABASE_URL).toBe(runtime.storage.postgres.url);
    expect(runtime.env.VPM_ALIAS_PUBLICATION_CATALOG_DATABASE_URL).toBe(
      runtime.storage.postgres.url
    );
    expect(runtime.env.COMMON_S3_BUCKET).toBe(runtime.storage.buckets.common.bucket);
    expect(runtime.env.METADATA_S3_BUCKET).toBe(runtime.storage.buckets.metadata.bucket);
    expect(runtime.env.PROTECTED_S3_BUCKET).toBe(runtime.storage.buckets.protected.bucket);
    expect(runtime.env.QUARANTINE_S3_BUCKET).toBe(runtime.storage.buckets.quarantine.bucket);
    expect(runtime.env.RENDITION_S3_BUCKET).toBeUndefined();
    expect(runtime.env.YUCP_WRANGLER_PERSIST_PATH).toBe(path.join(storageRoot, 'wrangler-r2'));
    expect(runtime.env.MATERIALIZER_ORIGIN_URL).toBe('http://127.0.0.1:8788');
    const importerLedger = JSON.parse(runtime.env.VPM_IMPORTER_RELEASE_LEDGER_JSON ?? 'null') as {
      releases?: Record<string, { sha256?: string }>;
      schemaVersion?: number;
    } | null;
    expect(importerLedger?.schemaVersion).toBe(1);
    expect(Object.keys(importerLedger?.releases ?? {})).toEqual(['0.0.1']);
    expect(Object.values(importerLedger?.releases ?? {})[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);

    await runtime.stop();
    await runtime.stop();

    expect(existsSync(storageRoot)).toBeFalse();
    for (const containerName of [postgresContainer, minioContainer]) {
      const inspect = Bun.spawnSync(['docker', 'inspect', containerName]);
      expect(inspect.exitCode).not.toBe(0);
    }
  }, 180_000);

  test('the disposable runtime removes only its exact HyperDX resources', async () => {
    const runtime = await startDisposableDevRuntime({
      commands: [],
      infisical: false,
      importerPackagePath: importerFixturePath,
      packageRuntimeAuthBaseUrl: 'http://127.0.0.1:3211/api/auth',
      prefixOutput: false,
    });
    const containerName = runtime.env.HYPERDX_DEV_CONTAINER_NAME;
    if (!containerName) {
      await runtime.stop();
      throw new Error('The disposable runtime did not expose its HyperDX container name');
    }
    const ownedVolumes = [
      `${containerName}-db`,
      `${containerName}-ch-data`,
      `${containerName}-ch-logs`,
    ];
    const unrelatedVolume = `${containerName}-unrelated`;
    try {
      for (const volume of [...ownedVolumes, unrelatedVolume]) {
        expect(runDocker(['volume', 'create', volume]).exitCode).toBe(0);
      }
      expect(runDocker(['create', '--name', containerName, POSTGRES_17_IMAGE]).exitCode).toBe(0);

      await runtime.stop();

      expect(runDocker(['inspect', containerName]).exitCode).not.toBe(0);
      for (const volume of ownedVolumes) {
        expect(runDocker(['volume', 'inspect', volume]).exitCode).not.toBe(0);
      }
      expect(runDocker(['volume', 'inspect', unrelatedVolume]).exitCode).toBe(0);
    } finally {
      await runtime.stop().catch(() => undefined);
      runDocker(['rm', '--force', containerName]);
      for (const volume of [...ownedVolumes, unrelatedVolume]) {
        runDocker(['volume', 'rm', '--force', volume]);
      }
    }
  }, 180_000);

  test('a failed owned dependency startup is cleaned before the error escapes', async () => {
    const startupError = new Error('startup failed');
    let cleanupCount = 0;

    await expect(
      rethrowAfterOwnedCleanup(startupError, true, async () => {
        cleanupCount += 1;
      })
    ).rejects.toBe(startupError);
    expect(cleanupCount).toBe(1);

    await expect(
      rethrowAfterOwnedCleanup(startupError, false, async () => {
        cleanupCount += 1;
      })
    ).rejects.toBe(startupError);
    expect(cleanupCount).toBe(1);
  });

  test('the self-hosted runtime exposes real Better Auth component access', async () => {
    const ports = await allocateDevPortSet();
    const runtime = await startDisposableDevRuntime({
      commands: [],
      convexProfile: 'self-hosted',
      infisical: false,
      importerPackagePath: importerFixturePath,
      ports,
      prefixOutput: false,
    });
    try {
      const adminKey = runtime.convex?.adminKey;
      const backendUrl = runtime.convex?.backendUrl;
      const betterAuthSecret = runtime.env.BETTER_AUTH_SECRET;
      if (!adminKey || !backendUrl || !betterAuthSecret) {
        throw new Error('Self-hosted Convex runtime did not expose Better Auth access');
      }
      const bootstrap = createLocalBetterAuthBootstrap({
        adminKey,
        backendUrl,
        betterAuthSecret,
      });
      try {
        const enrollment = await bootstrap.createEnrollment('Lifecycle Creator');
        expect(enrollment.authUserId).toBeTruthy();
        expect(enrollment.sessionToken).toContain('.');
      } finally {
        await bootstrap.cleanup();
      }
    } finally {
      await runtime.stop();
    }
  }, 300_000);

  test('the executable entry point awaits asynchronous startup', async () => {
    const source = await readFile(path.join(process.cwd(), 'ops', 'dev-supervisor.ts'), 'utf8');
    expect(source).toContain('await main();');
    expect(source).toContain('startInteractiveDevRuntime({');
    expect(source).not.toContain(
      'const runtime = await startDisposableDevRuntime({\n    infisical: cliOptions.infisical'
    );
  });

  test('Infisical development keeps the local browser origin', () => {
    expect(
      applyInfisicalDevSecrets(
        {
          FRONTEND_URL: 'http://bootstrap.invalid',
          INFISICAL_PROJECT_ID: 'project-1',
          MATERIALIZATION_KEY_BROKER_BASE_URL: 'https://stale-broker.invalid',
        },
        {
          FRONTEND_URL: 'https://app.example.test',
          MATERIALIZATION_KEY_BROKER_BASE_URL: 'https://coupling.example.test',
        }
      )
    ).toMatchObject({
      FRONTEND_URL: 'http://localhost:3000',
      INFISICAL_PROJECT_ID: 'project-1',
      MATERIALIZATION_KEY_BROKER_BASE_URL: 'https://coupling.example.test',
    });
  });

  test('applyLocalDevDefaults prefers the local ClickStack endpoints for dev runs', async () => {
    const fixturePath = path.join(process.cwd(), 'ops', 'test-fixtures', 'echo-env.mjs');
    const child = spawn(process.execPath, [fixturePath], {
      cwd: process.cwd(),
      env: applyLocalDevDefaults({
        FRONTEND_URL: 'http://localhost:9999',
        HYPERDX_APP_URL: 'https://app.hyperdx.example',
        HYPERDX_OTLP_HTTP_URL: 'https://otel.hyperdx.example',
        HYPERDX_OTLP_GRPC_URL: 'otel.hyperdx.example:4317',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.hyperdx.example',
      }),
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    child.stdout?.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    const [exitCode] = await once(child, 'close');
    const outputText = Buffer.concat(stdoutChunks).toString('utf8').trim();

    expect(exitCode).toBe(0);
    expect(JSON.parse(outputText)).toEqual({
      FRONTEND_URL: 'http://localhost:9999',
      HYPERDX_APP_URL: 'http://localhost:8080',
      HYPERDX_OTLP_HTTP_URL: 'http://localhost:4318',
      HYPERDX_OTLP_GRPC_URL: 'localhost:4317',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    });
  });

  test('applyLocalDevDefaults keeps explicit HyperDX endpoints when remote mode is requested', async () => {
    const fixturePath = path.join(process.cwd(), 'ops', 'test-fixtures', 'echo-env.mjs');
    const child = spawn(process.execPath, [fixturePath], {
      cwd: process.cwd(),
      env: applyLocalDevDefaults({
        HYPERDX_DEV_USE_REMOTE: 'true',
        HYPERDX_APP_URL: 'https://app.hyperdx.example',
        HYPERDX_OTLP_HTTP_URL: 'https://otel.hyperdx.example',
        HYPERDX_OTLP_GRPC_URL: 'otel.hyperdx.example:4317',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.hyperdx.example',
      }),
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    child.stdout?.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    const [exitCode] = await once(child, 'close');
    const outputText = Buffer.concat(stdoutChunks).toString('utf8').trim();

    expect(exitCode).toBe(0);
    expect(JSON.parse(outputText)).toEqual({
      FRONTEND_URL: 'http://localhost:3000',
      HYPERDX_APP_URL: 'https://app.hyperdx.example',
      HYPERDX_OTLP_HTTP_URL: 'https://otel.hyperdx.example',
      HYPERDX_OTLP_GRPC_URL: 'otel.hyperdx.example:4317',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.hyperdx.example',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    });
  });

  test('buildHyperdxDockerArgs exposes the supported local HyperDX ports', () => {
    expect(
      buildHyperdxDockerArgs({
        HYPERDX_USAGE_STATS_ENABLED: 'false',
        HYPERDX_DEV_VOLUME_MODE: 'named',
      })
    ).toEqual([
      'run',
      '--rm',
      '--name',
      'yucp-hyperdx-dev',
      '-p',
      '8080:8080',
      '-p',
      '4317:4317',
      '-p',
      '4318:4318',
      '-v',
      'yucp-hyperdx-dev-db:/data/db',
      '-v',
      'yucp-hyperdx-dev-ch-data:/var/lib/clickhouse',
      '-v',
      'yucp-hyperdx-dev-ch-logs:/var/log/clickhouse-server',
      '-e',
      'USAGE_STATS_ENABLED=false',
      'clickhouse/clickstack-all-in-one:latest',
    ]);
  });

  test('buildHyperdxDockerArgs supports explicit bind mounts when requested', () => {
    expect(buildHyperdxDockerArgs({ HYPERDX_DEV_VOLUME_MODE: 'bind' })).toEqual([
      'run',
      '--rm',
      '--name',
      'yucp-hyperdx-dev',
      '-p',
      '8080:8080',
      '-p',
      '4317:4317',
      '-p',
      '4318:4318',
      '-v',
      `${path.join(process.cwd(), '.volumes', 'hyperdx', 'db')}:/data/db`,
      '-v',
      `${path.join(process.cwd(), '.volumes', 'hyperdx', 'ch_data')}:/var/lib/clickhouse`,
      '-v',
      `${path.join(process.cwd(), '.volumes', 'hyperdx', 'ch_logs')}:/var/log/clickhouse-server`,
      '-e',
      'USAGE_STATS_ENABLED=false',
      'clickhouse/clickstack-all-in-one:latest',
    ]);
  });

  test('isDockerUnavailable recognizes the Docker Desktop daemon-offline error from Windows', () => {
    expect(
      isDockerUnavailable(
        'failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the daemon is running: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.'
      )
    ).toBe(true);
  });

  test('killProcessTree tears down spawned child trees', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'yucp-dev-supervisor-'));
    const infoPath = path.join(tempDir, 'tree.json');
    const fixturePath = path.join(process.cwd(), 'ops', 'test-fixtures', 'process-tree-parent.mjs');
    const fixture = spawn(process.execPath, [fixturePath, infoPath], {
      cwd: process.cwd(),
      stdio: 'ignore',
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const fixtureClosed = once(fixture, 'close');

    expect(fixture.pid).toBeDefined();

    const info = JSON.parse(
      await waitFor(
        async () => readFile(infoPath, 'utf8'),
        (contents) => contents.trim().length > 0
      )
    ) as {
      parentPid: number;
      grandchildPid: number;
    };

    expect(isProcessAlive(info.parentPid)).toBe(true);
    expect(isProcessAlive(info.grandchildPid)).toBe(true);

    await killProcessTree(info.parentPid, 'SIGINT');
    await fixtureClosed;

    await waitFor(
      async () => ({
        parentAlive: isProcessAlive(info.parentPid),
        grandchildAlive: isProcessAlive(info.grandchildPid),
      }),
      (state) => !state.parentAlive && !state.grandchildAlive
    );
  }, 20_000);

  test('buildDevCommands keeps the tunnel helper optional', () => {
    expect(buildDevCommands({}, false).find((command) => command.name === 'tunnel')).toMatchObject({
      required: false,
    });
  });

  test('buildDevCommands propagates a reserved lifecycle port set', () => {
    const commands = buildDevCommands({}, false, {
      api: 41001,
      coupling: 41008,
      convexBackend: 42010,
      convexDashboard: 42091,
      convexSite: 42011,
      delivery: 41003,
      hyperdxApp: 41080,
      hyperdxOtlpGrpc: 41017,
      hyperdxOtlpHttp: 41018,
      ingest: 41002,
      materializationControl: 41012,
      materializationSource: 41005,
      publicVpm: 41004,
      web: 41000,
    });

    expect(commands.find((command) => command.name === 'api')?.env).toMatchObject({
      FRONTEND_URL: 'http://localhost:41000',
      PORT: '41001',
    });
    expect(commands.find((command) => command.name === 'web')?.env).toMatchObject({
      API_BASE_URL: 'http://127.0.0.1:41001',
      WEB_DEV_PORT: '41000',
    });
    expect(commands.find((command) => command.name === 'ingest-tus')?.env).toMatchObject({
      PORT: '41002',
    });
    expect(commands.find((command) => command.name === 'materializer-linux')?.env).toMatchObject({
      MATERIALIZATION_CONTROL_PLANE_BASE_URL: 'http://127.0.0.1:41012',
      MATERIALIZATION_HEALTH_PORT: '41008',
      MATERIALIZATION_SOURCE_BASE_URL: 'http://127.0.0.1:41005',
    });
  });

  test('development readiness uses the Vite static client instead of an application route', () => {
    const ports = {
      ...(DEFAULT_DEV_PORTS as typeof DEFAULT_DEV_PORTS),
      web: 49_999,
    };

    expect(buildDevReadinessEndpoints(ports)).toContain('http://localhost:49999/@vite/client');
    expect(buildDevReadinessEndpoints(ports)).not.toContain('http://localhost:49999/');
  });

  test('development readiness uses the versioned Linux materializer health contract', () => {
    const endpoints = buildDevReadinessEndpoints(DEFAULT_DEV_PORTS);

    expect(endpoints).toContain('http://127.0.0.1:8788/v2/health');
    expect(endpoints).not.toContain('http://127.0.0.1:8788/health');
  });

  test('allocateDevPortSet returns unique loopback ports', async () => {
    const ports = await allocateDevPortSet();
    const values = Object.values(ports);
    expect(new Set(values).size).toBe(values.length);
    expect(values.every((port) => Number.isSafeInteger(port) && port > 0)).toBeTrue();
  });

  test('waitForDevHttpReadiness accepts a real listening endpoint', async () => {
    const server = Bun.serve({
      fetch: () => new Response('ready'),
      hostname: '127.0.0.1',
      port: 0,
    });
    try {
      await waitForDevHttpReadiness([`http://127.0.0.1:${server.port}/health`]);
    } finally {
      server.stop(true);
    }
  });

  test('buildDevCommands starts every real package storage and delivery process', () => {
    const commands = buildDevCommands(
      {
        COMMON_CHUNK_PREFIX: 'chunks/',
        COMMON_S3_ACCESS_KEY_ID: 'local-common-key',
        COMMON_S3_BUCKET: 'local-common',
        COMMON_S3_ENDPOINT: 'http://127.0.0.1:49152',
        COMMON_S3_REGION: 'us-east-1',
        COMMON_S3_SECRET_ACCESS_KEY: 'local-common-secret',
        METADATA_INDEX_PREFIX: 'indexes/',
        METADATA_S3_ACCESS_KEY_ID: 'local-metadata-key',
        METADATA_S3_BUCKET: 'local-metadata',
        METADATA_S3_ENDPOINT: 'http://127.0.0.1:49152',
        METADATA_S3_REGION: 'us-east-1',
        METADATA_S3_SECRET_ACCESS_KEY: 'local-metadata-secret',
        PACKAGE_DELIVERY_AUDIENCE: 'http://127.0.0.1:3003',
        PACKAGE_INSTALL_ISSUER: 'http://127.0.0.1:3001',
        PACKAGE_INSTALL_SIGNING_KEY_ID: 'local-install-key',
        PACKAGE_INSTALL_SIGNING_PUBLIC_KEY: 'local-install-public-key',
      },
      true
    );

    expect(commands.find((command) => command.name === 'ingest-tus')).toMatchObject({
      command: 'bun run --watch ops/ingest-tus/server.ts',
      env: { PORT: '3002' },
    });
    expect(commands.find((command) => command.name === 'scheduler')).toMatchObject({
      command: 'bun run ops/scheduler/server.ts',
    });
    expect(commands.find((command) => command.name === 'storage-gc')).toMatchObject({
      command: 'bun run ops/gc/server.ts',
      required: true,
    });
    expect(commands.find((command) => command.name === 'materialization-control')).toMatchObject({
      command: 'bun run --watch ops/materialization/server.ts',
    });
    expect(commands.find((command) => command.name === 'materializer-linux')).toMatchObject({
      command: 'bun run ops/materialization/localWslMaterializer.ts',
    });
    expect(commands.find((command) => command.name === 'materialization-source')).toMatchObject({
      command: 'bun x tsx watch services/materialization-source-worker/testDevServer.ts',
    });
    expect(commands.find((command) => command.name === 'coupling')).toBeUndefined();
    expect(
      commands.some((command) => command.cwd?.replaceAll('\\', '/').endsWith('/ca-coupling'))
    ).toBeFalse();
    const deliveryCommand = commands.find((command) => command.name === 'delivery');
    expect(deliveryCommand).toMatchObject({
      command: 'bun x tsx watch services/delivery-worker/testDevServer.ts',
      env: {
        BUYER_FLOW_COMMON_CHUNK_PREFIX: 'chunks/',
        BUYER_FLOW_METADATA_INDEX_PREFIX: 'indexes/',
        BUYER_FLOW_PACKAGE_DELIVERY_AUDIENCE: 'http://127.0.0.1:3003',
        BUYER_FLOW_PACKAGE_INSTALL_ISSUER: 'http://127.0.0.1:3001',
        BUYER_FLOW_PACKAGE_INSTALL_SIGNING_KEY_ID: 'local-install-key',
        BUYER_FLOW_PACKAGE_INSTALL_SIGNING_PUBLIC_KEY: 'local-install-public-key',
        BUYER_FLOW_DELIVERY_PORT: '3003',
        BUYER_FLOW_KEEP_ALIVE: '1',
        BUYER_FLOW_STORAGE_FORMAT_VERSION: 'desync-uncompressed-sha256-v1',
      },
    });
    const materializationSourceCommand = commands.find(
      (command) => command.name === 'materialization-source'
    );
    for (const workerCommand of [deliveryCommand, materializationSourceCommand]) {
      expect(Object.keys(workerCommand?.env ?? {}).filter((name) => name.includes('_S3_'))).toEqual(
        []
      );
    }
    expect(commands.find((command) => command.name === 'vpm-public')).toMatchObject({
      command: 'bun run ops/importer/localVpmServer.ts',
      env: { PORT: '3004' },
    });
  });

  test('applyLocalStorageProfile shares local upload authority without changing Infisical', () => {
    const storage = {
      buckets: {
        common: storageRoleFixture('common'),
        metadata: storageRoleFixture('metadata'),
        protected: storageRoleFixture('protected'),
        quarantine: storageRoleFixture('quarantine'),
        renditions: storageRoleFixture('renditions'),
      },
      postgres: {
        url: 'postgres://postgres:local-password@127.0.0.1:49153/local',
      },
      runId: 'fixture',
      scratchRoot: 'C:/tmp/yucp-pipeline-scratch',
      uploadDir: 'C:/tmp/yucp-upload',
    } as DisposableStorageHarness;
    const profileSecrets = {
      couplingServiceSharedSecret: 'local-coupling-service-secret',
      installSigningKeyId: 'local-install-key',
      installSigningPrivateKey: 'local-install-private-key',
      installSigningPublicKey: 'local-install-public-key',
      materializationApiSharedSecret: 'local-materialization-api-secret',
      materializationCapabilityKeyId: 'local-capability-key',
      materializationCapabilityPrivateKey: 'local-capability-private-key',
      materializationCapabilityPublicKey: 'local-capability-public-key',
      materializationKeyBrokerSharedSecret: 'local-key-broker-shared-secret',
      materializationMaterializerSharedSecret: 'local-materializer-shared-secret',
      materializationRenditionSharedSecret: 'local-rendition-shared-secret',
      materializationReceiptKeyId: 'local-receipt-key',
      materializationReceiptPrivateKey: 'local-receipt-private-key',
      materializationReceiptPublicKey: 'local-receipt-public-key',
      materializationSourceGrantKeyId: 'local-source-grant-key',
      materializationSourceGrantPrivateKey: 'local-source-grant-private-key',
      materializationSourceGrantPublicKey: 'local-source-grant-public-key',
      packageCatalogControlSharedSecret: 'local-package-catalog-control-secret',
      uploadHmacKey: 'local-upload-hmac-key',
    };

    const env = applyLocalStorageProfile(
      {
        INFISICAL_PROJECT_ID: 'keep-project-id',
      },
      storage,
      profileSecrets
    );

    expect(env).toMatchObject({
      COMMON_S3_ACCESS_KEY_ID: 'local-common-key',
      COMMON_S3_BUCKET: 'local-common',
      COMMON_S3_ENDPOINT: 'http://127.0.0.1:49152',
      METADATA_S3_ACCESS_KEY_ID: 'local-metadata-key',
      METADATA_S3_BUCKET: 'local-metadata',
      METADATA_S3_ENDPOINT: 'http://127.0.0.1:49152',
      PROTECTED_S3_ACCESS_KEY_ID: 'local-protected-key',
      PROTECTED_S3_BUCKET: 'local-protected',
      PROTECTED_S3_ENDPOINT: 'http://127.0.0.1:49152',
      QUARANTINE_S3_ACCESS_KEY_ID: 'local-quarantine-key',
      QUARANTINE_S3_BUCKET: 'local-quarantine',
      QUARANTINE_S3_ENDPOINT: 'http://127.0.0.1:49152',
      MATERIALIZATION_RENDITION_SHARED_SECRET: 'local-rendition-shared-secret',
      MATERIALIZER_ORIGIN_URL: 'http://127.0.0.1:8788',
      CATALOG_DATABASE_URL: 'postgres://postgres:local-password@127.0.0.1:49153/local',
      PACKAGE_CATALOG_DATABASE_URL: 'postgres://postgres:local-password@127.0.0.1:49153/local',
      VPM_ALIAS_PUBLICATION_CATALOG_DATABASE_URL:
        'postgres://postgres:local-password@127.0.0.1:49153/local',
      PACKAGE_CATALOG_CONTROL_INTERNAL_BASE_URL: 'http://localhost:3002',
      PACKAGE_CATALOG_CONTROL_SHARED_SECRET: 'local-package-catalog-control-secret',
      MATERIALIZATION_API_SHARED_SECRET: 'local-materialization-api-secret',
      MATERIALIZATION_CAPABILITY_KEY_ID: 'local-capability-key',
      MATERIALIZATION_CAPABILITY_PRIVATE_KEY: 'local-capability-private-key',
      MATERIALIZATION_CAPABILITY_PUBLIC_KEY: 'local-capability-public-key',
      MATERIALIZATION_CONTROL_PLANE_INTERNAL_BASE_URL: 'http://127.0.0.1:3012',
      MATERIALIZATION_CONTROL_PLANE_PUBLIC_BASE_URL: 'http://127.0.0.1:3012',
      MATERIALIZATION_KEY_BROKER_BASE_URL: 'http://127.0.0.1:8788',
      MATERIALIZATION_KEY_BROKER_SHARED_SECRET: 'local-key-broker-shared-secret',
      MATERIALIZATION_MATERIALIZER_SHARED_SECRET: 'local-materializer-shared-secret',
      YUCP_COUPLING_SERVICE_BASE_URL: 'http://127.0.0.1:8788',
      YUCP_COUPLING_SERVICE_SHARED_SECRET: 'local-coupling-service-secret',
      MATERIALIZATION_RECEIPT_KEY_ID: 'local-receipt-key',
      MATERIALIZATION_RECEIPT_PRIVATE_KEY: 'local-receipt-private-key',
      MATERIALIZATION_SOURCE_DELIVERY_BASE_URL: 'http://127.0.0.1:3005',
      MATERIALIZATION_SOURCE_GRANT_KEY_ID: 'local-source-grant-key',
      MATERIALIZATION_SOURCE_GRANT_PRIVATE_KEY: 'local-source-grant-private-key',
      MATERIALIZATION_SOURCE_GRANT_PUBLIC_KEY: 'local-source-grant-public-key',
      PACKAGE_DELIVERY_AUDIENCE: 'http://127.0.0.1:3003',
      PACKAGE_INSTALL_ISSUER: 'http://127.0.0.1:3001',
      PACKAGE_INSTALL_SIGNING_KEY_ID: 'local-install-key',
      PACKAGE_INSTALL_SIGNING_PRIVATE_KEY: 'local-install-private-key',
      PACKAGE_INSTALL_SIGNING_PUBLIC_KEY: 'local-install-public-key',
      INFISICAL_PROJECT_ID: 'keep-project-id',
      INGEST_ALLOWED_ORIGIN: 'http://localhost:3000',
      INGEST_MAX_BYTES: String(5 * 1024 * 1024 * 1024),
      INGEST_SCRATCH_DIR: 'C:/tmp/yucp-pipeline-scratch',
      INGEST_TUS_URL: 'http://localhost:3002',
      INGEST_UPLOAD_DIR: 'C:/tmp/yucp-upload',
      UPLOAD_HMAC_KEY: 'local-upload-hmac-key',
      VPM_BASE_URL: 'http://127.0.0.1:3001',
      VPM_PUBLIC_INDEX_URL: 'http://127.0.0.1:3004/index.json',
      YUCP_STORAGE_PROFILE: 'disposable',
      YUCP_WRANGLER_PERSIST_PATH: path.join('C:/tmp', 'wrangler-r2'),
    });
    expect(env).not.toHaveProperty('VPM_TOKEN_KEY');
    const interactiveEnv = applyLocalStorageProfile(
      {},
      storage,
      profileSecrets,
      DEFAULT_DEV_PORTS,
      'interactive'
    );
    expect(interactiveEnv).toMatchObject({
      YUCP_STORAGE_EPOCH: 'fixture',
      YUCP_STORAGE_PROFILE: 'interactive',
    });
    expect(interactiveEnv).not.toHaveProperty('YUCP_DISPOSABLE_RUN_ID');
  });

  test('waitForExit keeps required commands running when an optional helper exits early', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'yucp-dev-supervisor-optional-'));
    const startedPath = path.join(tempDir, 'required-started.txt');
    const runningFixturePath = path.join(process.cwd(), 'ops', 'test-fixtures', 'wait-forever.mjs');
    const failingFixturePath = path.join(
      process.cwd(),
      'ops',
      'test-fixtures',
      'exit-with-code.mjs'
    );
    const supervisor = new DevSupervisor(
      [
        {
          name: 'api',
          color: 'blue',
          command: `node ${runningFixturePath} ${startedPath}`,
        },
        {
          name: 'tunnel',
          color: 'cyan',
          command: `node ${failingFixturePath} 1`,
          required: false,
        },
      ],
      process.env,
      { prefixOutput: false }
    );

    await supervisor.start();
    const waitForExitPromise = supervisor.waitForExit();
    await waitFor(
      async () => readFile(startedPath, 'utf8'),
      (contents) => contents.includes('started')
    );
    await delay(250);

    const exitState = await Promise.race([
      waitForExitPromise.then((code) => ({ status: 'resolved' as const, code })),
      delay(500).then(() => ({ status: 'pending' as const })),
    ]);

    await supervisor.shutdown('SIGINT');
    await waitForExitPromise;

    expect(exitState).toEqual({ status: 'pending' });
  });
});
