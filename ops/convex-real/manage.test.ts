import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { withSelfHostedConvexEnvFileMovedAside } from './manage';

const harness = readFileSync(resolve(import.meta.dir, 'harness.ts'), 'utf8');

describe('self-hosted Convex environment isolation', () => {
  it('moves and restores every Bun-loaded env file after a self-hosted command fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'yucp-convex-real-env-'));
    const envFile = join(directory, '.env');
    const localEnvFile = join(directory, '.env.local');
    const original = 'CONVEX_DEPLOYMENT=local-cloud-target\n';
    const localOriginal = 'CONVEX_DEPLOY_KEY=local-cloud-key\n';
    writeFileSync(envFile, original);
    writeFileSync(localEnvFile, localOriginal);

    try {
      await expect(
        withSelfHostedConvexEnvFileMovedAside(async () => {
          expect(existsSync(envFile)).toBe(false);
          expect(existsSync(localEnvFile)).toBe(false);
          throw new Error('self-hosted command failed');
        }, directory)
      ).rejects.toThrow('self-hosted command failed');

      expect(readFileSync(envFile, 'utf8')).toBe(original);
      expect(readFileSync(localEnvFile, 'utf8')).toBe(localOriginal);
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
        }, directory);
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

  it('runs the operation without moving its directory when no Bun-loaded env files exist', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'yucp-convex-real-env-'));

    try {
      await withSelfHostedConvexEnvFileMovedAside(async () => {
        expect(existsSync(directory)).toBe(true);
      }, directory);
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
