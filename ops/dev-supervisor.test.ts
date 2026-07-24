import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyDisposableStorageProfile,
  applyLocalDevDefaults,
  buildDevCommands,
  DevSupervisor,
  isProcessAlive,
  killProcessTree,
} from './dev-supervisor';
import { buildHyperdxDockerArgs, isDockerUnavailable } from './hyperdx-dev';
import type { DisposableStorageHarness } from './testing/disposableStorageHarness';

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

describe('DevSupervisor', () => {
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

  test('buildDevCommands starts the real ingest and scheduler processes', () => {
    const commands = buildDevCommands({}, true);

    expect(commands.find((command) => command.name === 'ingest-tus')).toMatchObject({
      command: 'bun run ops/ingest-tus/server.ts',
      env: { PORT: '3002' },
    });
    expect(commands.find((command) => command.name === 'scheduler')).toMatchObject({
      command: 'bun run ops/scheduler/server.ts',
    });
  });

  test('applyDisposableStorageProfile shares local upload authority without changing Infisical', () => {
    const storage = {
      buckets: {
        common: {
          accessKeyId: 'local-common-key',
          bucket: 'local-common',
          chunkPrefix: 'chunks/',
          endpoint: 'http://127.0.0.1:49152',
          indexPrefix: 'indexes/',
          region: 'us-east-1',
          requestTimeoutMs: 30_000,
          secretAccessKey: 'local-common-secret',
        },
      },
      postgres: {
        url: 'postgres://postgres:local-password@127.0.0.1:49153/local',
      },
      uploadDir: 'C:/tmp/yucp-upload',
    } as DisposableStorageHarness;

    const env = applyDisposableStorageProfile(
      {
        INFISICAL_PROJECT_ID: 'keep-project-id',
      },
      storage,
      'local-upload-hmac-key'
    );

    expect(env).toMatchObject({
      CAS_S3_ACCESS_KEY_ID: 'local-common-key',
      CAS_S3_BUCKET: 'local-common',
      CAS_S3_ENDPOINT: 'http://127.0.0.1:49152',
      CATALOG_DATABASE_URL: 'postgres://postgres:local-password@127.0.0.1:49153/local',
      INFISICAL_PROJECT_ID: 'keep-project-id',
      INGEST_ALLOWED_ORIGIN: 'http://localhost:3000',
      INGEST_MAX_BYTES: String(5 * 1024 * 1024 * 1024),
      INGEST_TUS_URL: 'http://localhost:3002',
      INGEST_UPLOAD_DIR: 'C:/tmp/yucp-upload',
      UPLOAD_HMAC_KEY: 'local-upload-hmac-key',
      YUCP_STORAGE_PROFILE: 'disposable',
    });
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
