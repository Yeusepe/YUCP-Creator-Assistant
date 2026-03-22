import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('API OAuth discovery proxy', () => {
  it('proxies the root OAuth discovery path to Convex', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');

    expect(source).toContain("pathname === '/.well-known/oauth-authorization-server/api/auth'");
  });
});
