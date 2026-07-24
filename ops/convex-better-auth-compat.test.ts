import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..');

async function readRepoFile(relativePath: string) {
  return readFile(path.join(repoRoot, relativePath), 'utf8');
}

describe('@convex-dev/better-auth compatibility patch', () => {
  it('keeps the local Convex component on the Better Auth account contract', async () => {
    const rootPackageJson = JSON.parse(await readRepoFile('package.json')) as {
      dependencies?: Record<string, string>;
      overrides?: Record<string, string>;
    };
    const [schemaSource, generatorSource, runtimeAuthSource, schemaOptionsSource] =
      await Promise.all([
        readRepoFile('convex/betterAuth/schema.ts'),
        readRepoFile('convex/betterAuth/convexClient/createSchema.ts'),
        readRepoFile('convex/auth.ts'),
        readRepoFile('convex/betterAuth/options.ts'),
      ]);
    const supportedVersion = '1.7.0-rc.2';

    for (const packageName of [
      'better-auth',
      '@better-auth/api-key',
      '@better-auth/core',
      '@better-auth/oauth-provider',
      '@better-auth/passkey',
    ]) {
      expect(rootPackageJson.dependencies?.[packageName]).toBe(supportedVersion);
      expect(rootPackageJson.overrides?.[packageName]).toBe(supportedVersion);
    }
    expect(schemaSource).toContain('issuer: v.string()');
    expect(schemaSource).toContain('providerAccountId: v.string()');
    expect(schemaSource).not.toContain('accountId: v.string()');
    expect(generatorSource).toContain(
      'account: [["issuer", "providerAccountId"], ["providerId", "userId"]]'
    );
    expect(generatorSource).toContain(
      'apikey: ["configId", "expiresAt", "referenceId"]'
    );
    expect(schemaSource).toContain(`bunx auth@${supportedVersion} generate --output "./schema.ts"`);
    expect(generatorSource).toContain(`bunx auth@${supportedVersion} generate`);
    for (const authSource of [runtimeAuthSource, schemaOptionsSource]) {
      expect(authSource).toContain('additionalFields:');
      expect(authSource).toContain('userId: {');
      expect(authSource).toContain('input: false');
      expect(authSource).toContain('returned: false');
    }
  });

  it('pins Kysely to the Better Auth 1.6 compatible migration API', async () => {
    const rootPackageJson = JSON.parse(await readRepoFile('package.json')) as {
      overrides?: Record<string, string>;
    };

    expect(rootPackageJson.overrides?.kysely).toMatch(/^0\.28\.\d+$/);
  });

  it('accepts Better Auth 1.6 where.mode fields in the adapter validator', async () => {
    const [patchSource, installedAdapterSource, installedAdapterDist, installedCreateApiSource] =
      await Promise.all([
        readRepoFile('patches/@convex-dev%2Fbetter-auth@0.11.4.patch'),
        readRepoFile('node_modules/@convex-dev/better-auth/src/client/adapter-utils.ts'),
        readRepoFile('node_modules/@convex-dev/better-auth/dist/client/adapter-utils.js'),
        readRepoFile('node_modules/@convex-dev/better-auth/src/client/create-api.ts'),
      ]);

    const expectedSnippet =
      'mode: v.optional(v.union(v.literal("sensitive"), v.literal("insensitive")))';

    expect(patchSource).toContain(expectedSnippet);
    expect(installedAdapterSource).toContain(expectedSnippet);
    expect(installedAdapterDist).toContain(expectedSnippet);
    expect(installedCreateApiSource).toContain(expectedSnippet);
  });
});
