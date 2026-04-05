import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const lazyRoutePairs = [
  [
    '../../src/routes/_authenticated/dashboard/index.tsx',
    '../../src/routes/_authenticated/dashboard/index.lazy.tsx',
  ],
  [
    '../../src/routes/_authenticated/dashboard/audit-logs.tsx',
    '../../src/routes/_authenticated/dashboard/audit-logs.lazy.tsx',
  ],
  [
    '../../src/routes/_authenticated/dashboard/billing.tsx',
    '../../src/routes/_authenticated/dashboard/billing.lazy.tsx',
  ],
  [
    '../../src/routes/_authenticated/dashboard/certificates.tsx',
    '../../src/routes/_authenticated/dashboard/certificates.lazy.tsx',
  ],
  [
    '../../src/routes/_authenticated/dashboard/collaboration.tsx',
    '../../src/routes/_authenticated/dashboard/collaboration.lazy.tsx',
  ],
  [
    '../../src/routes/_authenticated/dashboard/forensics.tsx',
    '../../src/routes/_authenticated/dashboard/forensics.lazy.tsx',
  ],
  [
    '../../src/routes/_authenticated/dashboard/integrations.tsx',
    '../../src/routes/_authenticated/dashboard/integrations.lazy.tsx',
  ],
  [
    '../../src/routes/_authenticated/dashboard/packages.tsx',
    '../../src/routes/_authenticated/dashboard/packages.lazy.tsx',
  ],
  [
    '../../src/routes/_authenticated/dashboard/server-rules.tsx',
    '../../src/routes/_authenticated/dashboard/server-rules.lazy.tsx',
  ],
  [
    '../../src/routes/_authenticated/account/index.tsx',
    '../../src/routes/_authenticated/account/index.lazy.tsx',
  ],
  [
    '../../src/routes/_authenticated/account/authorized-apps.tsx',
    '../../src/routes/_authenticated/account/authorized-apps.lazy.tsx',
  ],
  [
    '../../src/routes/_authenticated/account/certificates.tsx',
    '../../src/routes/_authenticated/account/certificates.lazy.tsx',
  ],
  [
    '../../src/routes/_authenticated/account/connections.tsx',
    '../../src/routes/_authenticated/account/connections.lazy.tsx',
  ],
  [
    '../../src/routes/_authenticated/account/licenses.tsx',
    '../../src/routes/_authenticated/account/licenses.lazy.tsx',
  ],
  [
    '../../src/routes/_authenticated/account/privacy.tsx',
    '../../src/routes/_authenticated/account/privacy.lazy.tsx',
  ],
  [
    '../../src/routes/_authenticated/account/verify.tsx',
    '../../src/routes/_authenticated/account/verify.lazy.tsx',
  ],
] as const;

describe('authenticated leaf route laziness', () => {
  it('keeps authenticated dashboard and account leaf routes in lazy companion files', () => {
    for (const [routePath, lazyRoutePath] of lazyRoutePairs) {
      const absoluteRoutePath = resolve(__dirname, routePath);
      const absoluteLazyRoutePath = resolve(__dirname, lazyRoutePath);

      expect(existsSync(absoluteLazyRoutePath)).toBe(true);

      const routeSource = readFileSync(absoluteRoutePath, 'utf8');
      const lazyRouteSource = readFileSync(absoluteLazyRoutePath, 'utf8');

      expect(routeSource).toContain('createFileRoute');
      expect(lazyRouteSource).toContain('createLazyFileRoute');
    }
  });
});
