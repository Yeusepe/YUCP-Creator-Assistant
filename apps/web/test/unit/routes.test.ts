import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { routeTree } from '@/routeTree.gen';

const ROUTES_DIR = resolve(__dirname, '../../src/routes');

/**
 * Validates that every expected route file exists and the route tree is generated.
 */
describe('Route Tree', () => {
  const expectedRouteFiles = [
    'sign-in.tsx',
    'sign-in-redirect.tsx',
    'connect.tsx',
    'collab-invite.tsx',
    'dashboard.tsx',
    'dashboard/index.tsx',
    'dashboard/integrations.tsx',
    'dashboard/collaboration.tsx',
    'dashboard/server-rules.tsx',
    'dashboard/audit-logs.tsx',
    'setup/jinxxy.tsx',
    'setup/lemonsqueezy.tsx',
    'setup/payhip.tsx',
    'setup/discord-role.tsx',
    'setup/vrchat.tsx',
    'verify/success.tsx',
    'verify/error.tsx',
    'oauth/login.tsx',
    'oauth/consent.tsx',
    'oauth/error.tsx',
    'legal/terms-of-service.tsx',
    'legal/privacy-policy.tsx',
    '$.tsx',
    'index.tsx',
    '__root.tsx',
  ];

  it('has a valid routeTree export', () => {
    expect(routeTree).toBeDefined();
  });

  for (const file of expectedRouteFiles) {
    it(`route file exists: ${file}`, () => {
      const fullPath = resolve(ROUTES_DIR, file);
      expect(existsSync(fullPath), `Missing route file: ${file}`).toBe(true);
    });
  }
});
