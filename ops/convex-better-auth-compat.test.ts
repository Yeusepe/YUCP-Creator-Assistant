import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..');

async function readRepoFile(relativePath: string) {
  return readFile(path.join(repoRoot, relativePath), 'utf8');
}

describe('@convex-dev/better-auth compatibility bridge', () => {
  it('uses one versioned dependency patch through official package interfaces', async () => {
    const [
      rootPackageSource,
      runtimeAuthSource,
      componentAuthSource,
      componentAdapterSource,
      bridgePatchSource,
      installedPackageSource,
    ] = await Promise.all([
      readRepoFile('package.json'),
      readRepoFile('convex/auth.ts'),
      readRepoFile('convex/betterAuth/auth.ts'),
      readRepoFile('convex/betterAuth/adapter.ts'),
      readRepoFile('patches/@convex-dev%2Fbetter-auth@0.12.5.patch'),
      readRepoFile('node_modules/@convex-dev/better-auth/package.json'),
    ]);
    const rootPackage = JSON.parse(rootPackageSource) as {
      dependencies?: Record<string, string>;
      overrides?: Record<string, string>;
      patchedDependencies?: Record<string, string>;
    };
    const installedPackage = JSON.parse(installedPackageSource) as {
      peerDependencies?: Record<string, string>;
    };

    expect(rootPackage.dependencies?.['@convex-dev/better-auth']).toBe('0.12.5');
    expect(rootPackage.patchedDependencies?.['@convex-dev/better-auth@0.12.5']).toBe(
      'patches/@convex-dev%2Fbetter-auth@0.12.5.patch'
    );
    expect(rootPackage.dependencies?.['better-auth']).toBe('1.7.0-rc.2');
    expect(rootPackage.overrides?.['better-auth']).toBe('1.7.0-rc.2');
    expect(installedPackage.peerDependencies?.['better-auth']).toBe(
      '>=1.7.0-rc.2 <1.8.0'
    );

    expect(runtimeAuthSource).toContain(
      "import { createClient, type GenericCtx } from '@convex-dev/better-auth';"
    );
    expect(runtimeAuthSource).toContain(
      "import { convex } from '@convex-dev/better-auth/plugins';"
    );
    expect(componentAuthSource).toContain(
      "import { convexAdapter } from '@convex-dev/better-auth';"
    );
    expect(componentAdapterSource).toContain(
      "import { createApi } from '@convex-dev/better-auth';"
    );

    expect(bridgePatchSource).toContain('consumeOne');
    expect(bridgePatchSource).toContain('incrementOne');
    expect(bridgePatchSource).toContain('getConvexOpenIdConfig');
    expect(bridgePatchSource).toContain('/convex/openid-configuration');
    const addedPatchLines = bridgePatchSource
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .join('\n');
    expect(addedPatchLines).not.toContain('better-auth/plugins/oidc-provider');
  });

  it('keeps only the local schema extension required by Better Auth 1.7 lookups', async () => {
    const [schemaSource, generatedSchemaSource] = await Promise.all([
      readRepoFile('convex/betterAuth/schema.ts'),
      readRepoFile('convex/betterAuth/schema.generated.ts'),
    ]);

    expect(generatedSchemaSource).toContain('issuer: v.string()');
    expect(generatedSchemaSource).toContain('providerAccountId: v.string()');
    expect(schemaSource).toContain(".index('credentialID', ['credentialID'])");
    expect(schemaSource).toContain(
      ".index('counter_credentialID', ['counter', 'credentialID'])"
    );
    expect(schemaSource).toContain(
      ".index('clientId_resourceId', ['clientId', 'resourceId'])"
    );
    expect(schemaSource).not.toContain('accountId: v.optional');
    expect(schemaSource).not.toContain('Transitional Better Auth');
  });

  it('does not deploy copied upstream code or a nonproduction migration', () => {
    for (const relativePath of [
      'convex/betterAuth/convexClient',
      'convex/betterAuth/convexPlugin.ts',
      'convex/betterAuth/convexPlugin.test.ts',
      'convex/betterAuth/accountIdentityMigration.ts',
      'convex/betterAuth/v17Migration.ts',
      'convex/betterAuthV17Migration.ts',
      'convex/betterAuthV17Migration.realtest.ts',
      'ops/better-auth-v17-migration.ts',
      'ops/better-auth-v17-migration.test.ts',
      'patches/@convex-dev%2Fbetter-auth@0.11.4.patch',
    ]) {
      expect(existsSync(path.join(repoRoot, relativePath))).toBeFalse();
    }
  });

  it('installs the patched atomic and discovery implementations', async () => {
    const [
      adapterSource,
      adapterDist,
      createApiSource,
      createApiDist,
      pluginSource,
      pluginDist,
      clientSource,
      clientDist,
    ] = await Promise.all([
      readRepoFile('node_modules/@convex-dev/better-auth/src/client/adapter.ts'),
      readRepoFile('node_modules/@convex-dev/better-auth/dist/client/adapter.js'),
      readRepoFile('node_modules/@convex-dev/better-auth/src/client/create-api.ts'),
      readRepoFile('node_modules/@convex-dev/better-auth/dist/client/create-api.js'),
      readRepoFile('node_modules/@convex-dev/better-auth/src/plugins/convex/index.ts'),
      readRepoFile('node_modules/@convex-dev/better-auth/dist/plugins/convex/index.js'),
      readRepoFile('node_modules/@convex-dev/better-auth/src/client/create-client.ts'),
      readRepoFile('node_modules/@convex-dev/better-auth/dist/client/create-client.js'),
    ]);

    for (const source of [adapterSource, adapterDist, createApiSource, createApiDist]) {
      expect(source).toContain('consumeOne');
      expect(source).toContain('incrementOne');
    }
    for (const source of [pluginSource, pluginDist]) {
      expect(source).toContain('getConvexOpenIdConfig');
      expect(source).not.toContain('better-auth/plugins/oidc-provider');
    }
    for (const source of [pluginSource, pluginDist, clientSource, clientDist]) {
      expect(source).toContain('/convex/openid-configuration');
    }
  });
});
