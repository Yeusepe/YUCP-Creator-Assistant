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
    '_authenticated.tsx',
    '_authenticated/dashboard.tsx',
    '_authenticated/dashboard/index.tsx',
    '_authenticated/dashboard/integrations.tsx',
    '_authenticated/dashboard/collaboration.tsx',
    '_authenticated/dashboard/billing.tsx',
    '_authenticated/dashboard/packages.tsx',
    '_authenticated/dashboard/server-rules.tsx',
    '_authenticated/dashboard/audit-logs.tsx',
    '_authenticated/account.tsx',
    '_authenticated/account/index.tsx',
    '_authenticated/verify/purchase.tsx',
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
    'oauth/callback/itchio.tsx',
    'legal/terms-of-service.tsx',
    'legal/privacy-policy.tsx',
    '$.tsx',
    'index.tsx',
    '__root.tsx',
  ];

  it('has a valid routeTree export', () => {
    expect(routeTree).toBeDefined();
  });

  it('keeps setup helper modules out of the route tree scanner', () => {
    expect(existsSync(resolve(ROUTES_DIR, 'setup/lemonsqueezySetupSupport.ts'))).toBe(false);
    expect(existsSync(resolve(ROUTES_DIR, 'setup/-lemonsqueezySetupSupport.ts'))).toBe(true);
  });

  for (const file of expectedRouteFiles) {
    it(`route file exists: ${file}`, () => {
      const fullPath = resolve(ROUTES_DIR, file);
      expect(existsSync(fullPath), `Missing route file: ${file}`).toBe(true);
    });
  }
});
