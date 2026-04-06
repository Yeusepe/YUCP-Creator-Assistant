import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isProcessAlive, killProcessTree } from './dev-supervisor';

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
