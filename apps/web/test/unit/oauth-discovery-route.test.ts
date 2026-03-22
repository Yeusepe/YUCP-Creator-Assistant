import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('OAuth discovery route', () => {
  it('defines the manual well-known route file required by Better Auth', () => {
    const routePath = resolve(
      __dirname,
      '../../src/routes/.well-known/oauth-authorization-server/api/auth.ts'
    );

    expect(existsSync(routePath)).toBe(true);
  });
});
