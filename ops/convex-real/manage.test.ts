import { describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  selfHostedConvexEnv,
  withSelfHostedConvexEnvFileMovedAside,
  writeRealBackendEnvFile,
} from './manage';

const harness = readFileSync(resolve(import.meta.dir, 'harness.ts'), 'utf8');

describe('self-hosted Convex environment isolation', () => {
  it('targets an isolated reserved-port profile', () => {
    const environment = selfHostedConvexEnv('admin-key', {
      backendPort: 42_010,
      dashboardPort: 42_091,
      projectName: 'yucp-lifecycle-run',
      sitePort: 42_011,
    });
    expect(environment.CONVEX_SELF_HOSTED_ADMIN_KEY).toBe('admin-key');
    expect(environment.CONVEX_SELF_HOSTED_URL).toBe('http://127.0.0.1:42010');
  });

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

  it('serializes concurrent environment isolation without losing the original file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'yucp-convex-real-env-'));
    const envFile = join(directory, '.env.local');
    const original = 'CONVEX_DEPLOYMENT=local-cloud-target\n';
    writeFileSync(envFile, original);
    let activeOperations = 0;
    let maximumActiveOperations = 0;

    try {
      await Promise.all(
        Array.from({ length: 2 }, () =>
          withSelfHostedConvexEnvFileMovedAside(async () => {
            activeOperations += 1;
            maximumActiveOperations = Math.max(maximumActiveOperations, activeOperations);
            await Bun.sleep(25);
            activeOperations -= 1;
          }, directory)
        )
      );

      expect(maximumActiveOperations).toBe(1);
      expect(readFileSync(envFile, 'utf8')).toBe(original);
      expect(readdirSync(directory)).toEqual(['.env.local']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('recovers an old lock when its owner was interrupted before writing ownership', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'yucp-convex-real-env-'));
    const lockPath = join(directory, '.convex-self-hosted-env.lock');
    writeFileSync(lockPath, '');
    const oldTimestamp = new Date(Date.now() - 11 * 60_000);
    utimesSync(lockPath, oldTimestamp, oldTimestamp);
    let isolation: Promise<void> | undefined;

    try {
      isolation = withSelfHostedConvexEnvFileMovedAside(async () => undefined, directory);
      const outcome = await Promise.race([
        isolation.then(() => 'completed' as const),
        Bun.sleep(250).then(() => 'timed-out' as const),
      ]);
      expect(outcome).toBe('completed');
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(lockPath, { force: true });
      await isolation?.catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses the deploy path's sanitized CLI runner for harness environment calls", () => {
    expect(harness).toContain(
      "runSelfHostedConvexCli(['env', ...args], env, { timeoutMs: 60_000 })"
    );
  });

  it('writes the exact lifecycle guest origin into the disposable auth environment', () => {
    const path = writeRealBackendEnvFile(undefined, {
      betterAuthAdditionalTrustedOrigins: ['http://192.0.2.10:3000'],
    });
    try {
      expect(readFileSync(path, 'utf8')).toContain(
        'BETTER_AUTH_ADDITIONAL_TRUSTED_ORIGINS_JSON=["http://192.0.2.10:3000"]'
      );
    } finally {
      rmSync(path, { force: true });
    }
  });
});
