import { afterAll, describe, expect, test } from 'bun:test';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { iconManifest } from '../apps/web/src/icons/manifest';

const WEB_READY_PATTERN = /Local:\s+(http:\/\/(?:localhost|127\.0\.0\.1):\d+)/;
const ANSI_ESCAPE_PREFIX = `${String.fromCharCode(27)}[`;
const REQUEST_TIMEOUT_MS = 5_000;
const STARTUP_TIMEOUT_MS = 90_000;
const BUN_EXECUTABLE = process.execPath;
const TEST_ASSETS_BUCKET = 'licensed-assets-test';
const TEST_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 14 14">
  <desc>Web Dev Runtime Streamline Icon: https://streamlinehq.com</desc>
  <path fill="#8fbffa" d="M0 0h7v7H0z" />
  <path fill="#2859c5" d="M7 7h7v7H7z" />
</svg>`;
const EXPECTED_ICON_OBJECT_PATHS = new Set(
  Object.values(iconManifest).map(
    (sourcePath) => `/${TEST_ASSETS_BUCKET}/icons/flex-flat-style/${sourcePath}`
  )
);
const INFISICAL_BOOTSTRAP_KEYS = [
  'INFISICAL_CLIENT_ID',
  'INFISICAL_CLIENT_SECRET',
  'INFISICAL_MACHINE_IDENTITY_ID',
  'INFISICAL_MACHINE_IDENTITY_SECRET',
  'INFISICAL_PROJECT_ID',
  'INFISICAL_TOKEN',
] as const;

const children = new Set<ChildProcessWithoutNullStreams>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripAnsi(value: string): string {
  return value
    .split(ANSI_ESCAPE_PREFIX)
    .map((segment, index) => (index === 0 ? segment : segment.replace(/^[0-9;]*m/, '')))
    .join('');
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function forceKillChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.platform !== 'win32' || !child.pid) {
    child.kill('SIGKILL');
    return;
  }

  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', () => resolve());
    killer.once('exit', () => resolve());
  });
}

function isChildProcessAlive(child: ChildProcessWithoutNullStreams): boolean {
  if (child.exitCode !== null) {
    return false;
  }
  if (!child.pid) {
    return false;
  }
  try {
    process.kill(child.pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!isChildProcessAlive(child)) {
    return;
  }

  if (process.platform === 'win32') {
    await forceKillChild(child);
  } else {
    child.kill();
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isChildProcessAlive(child)) {
      return;
    }
    await delay(100);
  }
  await forceKillChild(child);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isChildProcessAlive(child)) {
      return;
    }
    await delay(100);
  }
  throw new Error('Child process did not exit after SIGKILL');
}

afterAll(async () => {
  await Promise.all(Array.from(children, stopChild));
});

describe('web dev runtime', () => {
  test(
    'renders a route after the Worker-backed Vite server reports ready',
    async () => {
      const tempEnvDir = await mkdtemp(join(tmpdir(), 'yucp-web-worker-env-'));
      const localWorkerEnvPath = join(tempEnvDir, '.dev.vars');
      const output: string[] = [];
      const requestedIconPaths = new Set<string>();
      const assetServer = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(request) {
          const url = new URL(request.url);
          const objectPath = decodeURIComponent(url.pathname);
          if (request.method !== 'GET' || !EXPECTED_ICON_OBJECT_PATHS.has(objectPath)) {
            return new Response('Not found', { status: 404 });
          }
          requestedIconPaths.add(objectPath);
          return new Response(TEST_ICON_SVG, {
            headers: { 'Content-Type': 'image/svg+xml' },
          });
        },
      });
      const childEnv = { ...process.env };
      for (const key of INFISICAL_BOOTSTRAP_KEYS) {
        // A non-empty whitespace value shadows Bun's explicit .env.infisical load, while the
        // production normalizer still treats it as absent. This keeps the test on its local S3
        // server even when the developer running it has an ignored Infisical bootstrap file.
        childEnv[key] = ' ';
      }
      const child = spawn(BUN_EXECUTABLE, ['run', '--filter', '@yucp/web', 'worker:dev'], {
        cwd: process.cwd(),
        env: {
          ...childEnv,
          API_BASE_URL: process.env.API_BASE_URL ?? 'http://127.0.0.1:8787',
          ASSETS_S3_BUCKET: TEST_ASSETS_BUCKET,
          ASSETS_S3_ENDPOINT: `http://${assetServer.hostname}:${assetServer.port}`,
          ASSETS_S3_READONLY_ACCESS_KEY_ID: 'test-readonly-access-key',
          ASSETS_S3_READONLY_SECRET_ACCESS_KEY: 'test-readonly-secret-key',
          ASSETS_S3_REGION: 'us-east-1',
          CONVEX_SITE_URL: process.env.CONVEX_SITE_URL ?? 'https://test-yucp.convex.site',
          CONVEX_URL: process.env.CONVEX_URL ?? 'https://test-yucp.convex.cloud',
          CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true',
          FRONTEND_URL: process.env.FRONTEND_URL ?? 'http://127.0.0.1:0',
          SITE_URL: process.env.SITE_URL ?? 'http://127.0.0.1:0',
          WEB_LOCAL_ENV_PATH: localWorkerEnvPath,
          WEB_DEV_HOST: '127.0.0.1',
          WEB_DEV_PORT: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      children.add(child);

      try {
        child.stdout.on('data', (chunk) => output.push(String(chunk)));
        child.stderr.on('data', (chunk) => output.push(String(chunk)));

        const deadline = Date.now() + STARTUP_TIMEOUT_MS;
        let lastError: unknown;
        let response: Response | undefined;

        while (Date.now() < deadline) {
          if (child.exitCode !== null) {
            throw new Error(
              `web dev server exited before serving a route with code ${child.exitCode}.\n${output.join('')}`
            );
          }

          const text = stripAnsi(output.join(''));
          const readyMatch = WEB_READY_PATTERN.exec(text);
          if (readyMatch) {
            const baseUrl = readyMatch[1];
            try {
              response = await fetchWithTimeout(`${baseUrl}/`);
              break;
            } catch (error) {
              lastError = error;
            }
          }

          await delay(250);
        }

        if (!response) {
          throw new Error(
            `web dev server did not render / after reporting ready. Last error: ${
              lastError instanceof Error ? lastError.message : String(lastError)
            }\n${output.join('')}`
          );
        }

        const generatedEnv = await readFile(localWorkerEnvPath, 'utf8');
        expect(generatedEnv).toContain('API_BASE_URL=http://127.0.0.1:8787');

        const body = await response.text();
        if (response.status !== 200) {
          throw new Error(
            `web dev server returned HTTP ${response.status} for /. Body:\n${body.slice(
              0,
              2_000
            )}\nOutput:\n${output.join('')}`
          );
        }
        expect(body).toContain('<!DOCTYPE html>');
        expect(body).not.toContain('createContext is not a function');
        expect(output.join('')).not.toContain('createContext is not a function');
        expect(requestedIconPaths).toEqual(EXPECTED_ICON_OBJECT_PATHS);

        await stopChild(child);
        children.delete(child);
      } finally {
        await stopChild(child);
        children.delete(child);
        await assetServer.stop(true);
        await rm(tempEnvDir, { force: true, recursive: true });
      }
    },
    STARTUP_TIMEOUT_MS + 15_000
  );
});
