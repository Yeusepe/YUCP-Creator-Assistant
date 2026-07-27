import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadMaterializationControlClient } from '../apps/api/src/lib/materializationControlClient';
import {
  loadPackageInstallerTufRepositoryConfig,
  type PackageInstallerTufRepositoryEnvironment,
} from '../apps/api/src/lib/packageInstallerTufRepository';

const repoRoot = path.resolve(import.meta.dir, '..');

async function readOpsFile(relativePath: string) {
  return readFile(path.join(repoRoot, relativePath), 'utf8');
}

function readTemplateValue(template: string, key: string): string {
  const match = template.match(new RegExp(`^\\s+${key}:\\s+"([^"]+)"\\s*$`, 'm'));
  if (!match?.[1]) {
    throw new Error(`Missing Infisical template value for ${key}`);
  }
  return match[1];
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

  it('documents a production-safe exact-storage TUF repository', async () => {
    const secretsTemplate = await readOpsFile('ops/infisical/secrets.template.yaml');
    const exactStorageKeys = [
      'PACKAGE_INSTALLER_TUF_CATALOG_DATABASE_URL',
      'PACKAGE_INSTALLER_TUF_REPOSITORY_ID',
      'PACKAGE_INSTALLER_TUF_S3_ACCESS_KEY_ID',
      'PACKAGE_INSTALLER_TUF_S3_BUCKET',
      'PACKAGE_INSTALLER_TUF_S3_ENDPOINT',
      'PACKAGE_INSTALLER_TUF_S3_REGION',
      'PACKAGE_INSTALLER_TUF_S3_REQUEST_TIMEOUT_MS',
      'PACKAGE_INSTALLER_TUF_S3_SECRET_ACCESS_KEY',
    ];

    expect(secretsTemplate).not.toContain('PACKAGE_INSTALLER_TUF_REPOSITORY_ROOT:');
    for (const key of exactStorageKeys) {
      expect(secretsTemplate).toContain(`${key}:`);
    }
    const templateEnvironment = Object.fromEntries(
      exactStorageKeys.map((key) => [key, readTemplateValue(secretsTemplate, key)])
    ) as PackageInstallerTufRepositoryEnvironment;
    expect(
      loadPackageInstallerTufRepositoryConfig({
        ...templateEnvironment,
        NODE_ENV: 'production',
      })
    ).toMatchObject({
      kind: 'exact-storage',
      repositoryId: 'package-installer',
    });
  });

  it('configures the protected-package materialization control plane for the production API', async () => {
    const secretsTemplate = await readOpsFile('ops/infisical/secrets.template.yaml');
    const environment = {
      MATERIALIZATION_API_SHARED_SECRET: readTemplateValue(
        secretsTemplate,
        'MATERIALIZATION_API_SHARED_SECRET'
      ),
      MATERIALIZATION_CONTROL_PLANE_INTERNAL_BASE_URL: readTemplateValue(
        secretsTemplate,
        'MATERIALIZATION_CONTROL_PLANE_INTERNAL_BASE_URL'
      ),
    };

    expect(loadMaterializationControlClient(environment)).not.toBeNull();
  });
});
