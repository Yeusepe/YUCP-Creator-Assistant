import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { withSelfHostedConvexEnvFileMovedAside } from './manage';

const harness = readFileSync(resolve(import.meta.dir, 'harness.ts'), 'utf8');

describe('self-hosted Convex environment isolation', () => {
  it('restores .env.local after a self-hosted command fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'yucp-convex-real-env-'));
    const envFile = join(directory, '.env.local');
    const original = 'CONVEX_DEPLOYMENT=local-cloud-target\n';
    writeFileSync(envFile, original);

    try {
      await expect(
        withSelfHostedConvexEnvFileMovedAside(async () => {
          expect(existsSync(envFile)).toBe(false);
          throw new Error('self-hosted command failed');
        }, envFile)
      ).rejects.toThrow('self-hosted command failed');

      expect(readFileSync(envFile, 'utf8')).toBe(original);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves the operation error when .env.local is recreated', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'yucp-convex-real-env-'));
    const envFile = join(directory, '.env.local');
    const original = 'CONVEX_DEPLOYMENT=local-cloud-target\n';
    writeFileSync(envFile, original);

    try {
      try {
        await withSelfHostedConvexEnvFileMovedAside(async () => {
          writeFileSync(envFile, 'unexpected replacement\n');
          throw new Error('original deploy failure');
        }, envFile);
        throw new Error('Expected the self-hosted command to reject');
      } catch (error) {
        expect(error).toBeInstanceOf(AggregateError);
        expect(error).toHaveProperty('message', 'original deploy failure');
        expect((error as AggregateError).errors[0]).toHaveProperty(
          'message',
          'original deploy failure'
        );
      }

      expect(readFileSync(envFile, 'utf8')).toBe(original);
      expect(readdirSync(directory).some((entry) => entry.endsWith('.unexpected'))).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses the deploy path's sanitized CLI runner for harness environment calls", () => {
    expect(harness).toContain(
      "runSelfHostedConvexCli(['env', ...args], env, { timeoutMs: 60_000 })"
    );
  });
});
