import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(import.meta.dir, '..');

async function readRepoFile(relativePath: string) {
  return readFile(path.join(repoRoot, relativePath), 'utf8');
}

describe('@convex-dev/better-auth compatibility patch', () => {
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
