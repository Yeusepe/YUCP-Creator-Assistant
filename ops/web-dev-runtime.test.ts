import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const WEB_READY_PATTERN = /Local:\s+(http:\/\/(?:localhost|127\.0\.0\.1):\d+)/;
const REQUEST_TIMEOUT_MS = 5_000;
const STARTUP_TIMEOUT_MS = 90_000;

const children = new Set<ChildProcessWithoutNullStreams>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
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

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  child.kill();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (child.exitCode !== null || child.killed) {
      return;
    }
    await delay(100);
  }
  child.kill('SIGKILL');
}

afterAll(async () => {
  await Promise.all(Array.from(children, stopChild));
});

describe('web dev runtime', () => {
  test(
    'renders a route after the Worker-backed Vite server reports ready',
    async () => {
      const output: string[] = [];
      const child = spawn('bun', ['run', '--filter', '@yucp/web', 'worker:dev'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          API_BASE_URL: process.env.API_BASE_URL ?? 'http://127.0.0.1:8787',
          CONVEX_SITE_URL: process.env.CONVEX_SITE_URL ?? 'https://test-yucp.convex.site',
          CONVEX_URL: process.env.CONVEX_URL ?? 'https://test-yucp.convex.cloud',
          FRONTEND_URL: process.env.FRONTEND_URL ?? 'http://127.0.0.1:0',
          SITE_URL: process.env.SITE_URL ?? 'http://127.0.0.1:0',
          WEB_DEV_HOST: '127.0.0.1',
          WEB_DEV_PORT: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      children.add(child);

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

      await stopChild(child);
      children.delete(child);

      if (!response) {
        throw new Error(
          `web dev server did not render / after reporting ready. Last error: ${
            lastError instanceof Error ? lastError.message : String(lastError)
          }\n${output.join('')}`
        );
      }

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
    },
    STARTUP_TIMEOUT_MS + 15_000
  );
});
