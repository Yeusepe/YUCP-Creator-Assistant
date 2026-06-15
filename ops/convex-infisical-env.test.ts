import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..');

async function readOpsFile(relativePath: string) {
  return readFile(path.join(repoRoot, relativePath), 'utf8');
}

describe('Convex Infisical prod helpers', () => {
  it('forces the prod Infisical environment when --prod is used', async () => {
    const [infisicalConvexRun, syncConvexEnv] = await Promise.all([
      readOpsFile('ops/infisical-convex-run.ts'),
      readOpsFile('ops/sync-convex-env.ts'),
    ]);

    expect(infisicalConvexRun).not.toContain('const secrets = await fetchInfisicalSecrets();');
    expect(syncConvexEnv).not.toContain('const secrets = await fetchInfisicalSecrets();');

    expect(infisicalConvexRun).toContain("INFISICAL_ENV: isProd ? 'prod'");
    expect(syncConvexEnv).toContain("INFISICAL_ENV: isProd ? 'prod'");
  });

  it('syncs role-sync Workpool config to Convex', async () => {
    const [syncConvexEnv, secretsTemplate] = await Promise.all([
      readOpsFile('ops/sync-convex-env.ts'),
      readOpsFile('ops/infisical/secrets.template.yaml'),
    ]);
    // Both vars must sync to Convex. ROLE_SYNC_VIA_WORKPOOL is newly added to the template;
    // DISCORD_BOT_TOKEN already exists there.
    expect(syncConvexEnv).toContain("'ROLE_SYNC_VIA_WORKPOOL'");
    expect(syncConvexEnv).toContain("'DISCORD_BOT_TOKEN'");
    expect(secretsTemplate).toContain('ROLE_SYNC_VIA_WORKPOOL');
    expect(secretsTemplate).toContain('DISCORD_BOT_TOKEN');
  });
});
