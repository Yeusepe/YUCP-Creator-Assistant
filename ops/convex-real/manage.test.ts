import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSelfHostedConvexEnvFileMovedAside } from './manage';

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
});
