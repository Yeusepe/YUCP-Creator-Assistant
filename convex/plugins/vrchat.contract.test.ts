import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const vrchatSource = readFileSync(resolve(__dirname, './vrchat.ts'), 'utf8');

describe('VRChat Better Auth adapter contract', () => {
  it('uses the supported email lookup and verifies the provider account key', () => {
    expect(vrchatSource).toContain('findUserByEmail(email, {');
    expect(vrchatSource).toContain('includeAccounts: true');
    expect(vrchatSource).toContain("entry.providerId === 'vrchat'");
    expect(vrchatSource).toContain('entry.providerAccountId === vrchatUserId');
    expect(vrchatSource).toContain(
      "...buildBetterAuthOAuthAccountIdentity('vrchat', vrchatUserId)"
    );
    expect(vrchatSource).not.toContain('findOAuthUser(');
  });
});
