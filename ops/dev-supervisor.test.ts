import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildHyperdxDockerArgs, isDockerUnavailable } from './hyperdx-dev';
import { applyLocalDevDefaults, isProcessAlive, killProcessTree } from './dev-supervisor';

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

describe('DevSupervisor', () => {
  test('applyLocalDevDefaults seeds HyperDX and OTLP endpoints without overriding explicit values', async () => {
    const fixturePath = path.join(process.cwd(), 'ops', 'test-fixtures', 'echo-env.mjs');
    const child = spawn(process.execPath, [fixturePath], {
      cwd: process.cwd(),
      env: applyLocalDevDefaults({
        FRONTEND_URL: 'http://localhost:9999',
        HYPERDX_OTLP_HTTP_URL: 'http://localhost:54321',
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
      HYPERDX_API_KEY: 'local',
      HYPERDX_APP_URL: 'http://localhost:8080',
      HYPERDX_OTLP_HTTP_URL: 'http://localhost:54321',
      HYPERDX_OTLP_GRPC_URL: 'http://localhost:4317',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:54321',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    });
  });

  test('buildHyperdxDockerArgs exposes the supported local HyperDX ports', () => {
    expect(buildHyperdxDockerArgs({ HYPERDX_USAGE_STATS_ENABLED: 'false' })).toEqual([
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
      '-e',
      'USAGE_STATS_ENABLED=false',
      'docker.hyperdx.io/hyperdx/hyperdx-all-in-one',
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
});
