/**
 * Auth Guard Tests
 *
 * These tests verify that protected routes have proper authentication guards
 * in their beforeLoad handlers. This catches bugs like:
 * - Forgetting to add auth checks to new protected routes
 * - Auth guards that don't redirect to /sign-in
 * - Public routes that accidentally require auth
 * - Missing beforeLoad entirely on protected routes
 *
 * These are static analysis tests that read route source files,
 * similar to route-architecture.test.ts. They don't require a running server.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROUTES_DIR = join(__dirname, '../../src/routes');
const SRC_DIR = join(__dirname, '../../src');

function readRoute(name: string): string {
  return readFileSync(join(ROUTES_DIR, name), 'utf8');
}

function readSource(path: string): string {
  return readFileSync(join(SRC_DIR, path), 'utf8');
}

// Routes that MUST have shared auth guards (creator-authenticated subtree)
const PROTECTED_LAYOUT_ROUTES = ['_authenticated.tsx'];

// Child routes that inherit auth from the protected layout
const PROTECTED_CHILD_ROUTES = [
  '_authenticated/dashboard.tsx',
  '_authenticated/account.tsx',
  '_authenticated/verify/purchase.tsx',
];

// Routes that MUST NOT require auth (public-facing pages)
const PUBLIC_ROUTES = [
  'sign-in.tsx',
  'sign-in-redirect.tsx',
  'index.tsx',
  'legal/terms-of-service.tsx',
  'legal/privacy-policy.tsx',
];

// Setup wizard routes use setup tokens, not session auth.
// They should NOT have Better Auth session guards but may have their own token checks.
const SETUP_ROUTES = [
  'setup/discord-role.tsx',
  'setup/jinxxy.tsx',
  'setup/lemonsqueezy.tsx',
  'setup/payhip.tsx',
  'setup/vrchat.tsx',
];

describe('Auth guards: protected layout routes', () => {
  for (const route of PROTECTED_LAYOUT_ROUTES) {
    describe(route, () => {
      const source = readRoute(route);

      it('has a beforeLoad handler', () => {
        expect(source).toContain('beforeLoad');
      });

      it('loads protected auth state in beforeLoad', () => {
        expect(source).toContain('loadProtectedAuthState');
      });

      it('redirects unauthenticated users to /sign-in', () => {
        expect(source).toContain('/sign-in');
        // Should use redirect() or throw redirect
        const hasRedirect = source.includes('redirect(') || source.includes('throw redirect');
        expect(hasRedirect).toBe(true);
      });

      it('wraps protected routes with ConvexBetterAuthProvider', () => {
        expect(source).toContain('ConvexBetterAuthProvider');
      });
    });
  }
});

describe('Auth guards: protected child routes', () => {
  for (const route of PROTECTED_CHILD_ROUTES) {
    describe(route, () => {
      const source = readRoute(route);

      it('does not duplicate the shared sign-in redirect guard', () => {
        const hasInlineAuthGuard =
          source.includes('!context.isAuthenticated') ||
          source.includes('context.isAuthenticated') ||
          source.includes("to: '/sign-in'") ||
          source.includes('to: "/sign-in"');
        expect(hasInlineAuthGuard).toBe(false);
      });
    });
  }
});

describe('Auth guards: public routes', () => {
  for (const route of PUBLIC_ROUTES) {
    const source = readRoute(route);

    it(`${route} does not gate on a protected-layout auth redirect`, () => {
      // Public routes may check auth state for UI purposes
      // but should not throw redirect when !isAuthenticated
      const hasRequiredAuthGuard =
        source.includes('!context.isAuthenticated') &&
        source.includes("throw redirect({ to: '/sign-in'");
      expect(hasRequiredAuthGuard).toBe(false);
    });
  }
});

describe('Auth guards: sign-in route', () => {
  const source = readRoute('sign-in.tsx');

  it('has a beforeLoad handler', () => {
    expect(source).toContain('beforeLoad');
  });

  it('redirects AUTHENTICATED users away from sign-in', () => {
    // The sign-in page should use a lightweight server session check instead of
    // depending on root route auth context.
    const checksAuth = source.includes('getAuthSession');
    const throwsRedirect = source.includes('throw redirect');
    expect(checksAuth).toBe(true);
    expect(throwsRedirect).toBe(true);
  });

  it('does not depend on root route auth context', () => {
    expect(source).not.toContain('context.isAuthenticated');
    expect(source).not.toContain('context.token');
  });
});

describe('Auth guards: setup wizard routes use setup tokens', () => {
  for (const route of SETUP_ROUTES) {
    let source: string;
    try {
      source = readRoute(route);
    } catch {
      continue; // Route doesn't exist, skip
    }

    it(`${route} does not use Better Auth session for primary auth`, () => {
      // Setup routes should use setup tokens (via cookie/URL param),
      // not Better Auth getSession/useSession as the primary auth mechanism
      const usesBetterAuthAsPrimary =
        source.includes('auth.getSession') || source.includes('authClient.getSession');
      expect(usesBetterAuthAsPrimary).toBe(false);
    });
  }
});

describe('Auth configuration: auth client', () => {
  const source = readFileSync(join(__dirname, '../../src/lib/auth-client.ts'), 'utf8');

  it('uses convexClient plugin for the Convex-backed Better Auth client', () => {
    expect(source).toContain('convexClient');
  });

  it('does not use crossDomainClient because the app stays on same-origin Better Auth transport', () => {
    expect(source).not.toContain('crossDomainClient');
  });

  it('does not hardcode a baseURL (should use current origin)', () => {
    // A hardcoded baseURL would break when deployed to a different domain
    const hasHardcodedBaseUrl = /baseURL\s*:\s*['"]https?:\/\//.test(source);
    expect(hasHardcodedBaseUrl).toBe(false);
  });
});

describe('Auth configuration: auth proxy route', () => {
  const source = readFileSync(join(__dirname, '../../src/routes/api/auth/$.ts'), 'utf8');

  it('handles both GET and POST methods', () => {
    expect(source).toContain('GET');
    expect(source).toContain('POST');
  });

  it('delegates to the auth handler (not custom logic)', () => {
    expect(source).toContain('handler');
  });
});

describe('Auth configuration: root route SSR auth', () => {
  const source = readFileSync(join(__dirname, '../../src/routes/__root.tsx'), 'utf8');
  const protectedSource = readFileSync(
    join(__dirname, '../../src/routes/_authenticated.tsx'),
    'utf8'
  );

  it('does not call getAuth in beforeLoad from the root route', () => {
    expect(source).not.toContain('getAuth');
    expect(source).not.toContain('loadRootAuthState');
  });

  it('moves SSR auth token setup into the protected layout', () => {
    const handlesSsrAuthInline =
      protectedSource.includes('serverHttpClient') && protectedSource.includes('setAuth');
    const delegatesToSsrAuthHelper = protectedSource.includes('loadProtectedAuthState');
    expect(handlesSsrAuthInline || delegatesToSsrAuthHelper).toBe(true);
  });

  it('does not wrap the root tree with ConvexBetterAuthProvider', () => {
    expect(source).not.toContain('ConvexBetterAuthProvider');
  });

  it('keeps HeadContent outside the protected Better Auth provider tree', () => {
    const providerIndex = protectedSource.indexOf('<ConvexBetterAuthProvider');
    const headContentIndex = source.indexOf('<HeadContent />');

    expect(providerIndex).toBeGreaterThan(-1);
    expect(headContentIndex).toBeGreaterThan(-1);
    expect(protectedSource).not.toContain('<HeadContent />');
  });

  it('returns auth state from the protected layout route context', () => {
    const returnsAuthStateInline = protectedSource.includes('isAuthenticated');
    const delegatesToSsrAuthHelper = protectedSource.includes('loadProtectedAuthState');
    expect(returnsAuthStateInline || delegatesToSsrAuthHelper).toBe(true);
  });
});

describe('Auth configuration: router uses expectAuth', () => {
  const source = readFileSync(join(__dirname, '../../src/router.tsx'), 'utf8');
  const rootSource = readFileSync(join(__dirname, '../../src/routes/__root.tsx'), 'utf8');

  it('creates ConvexQueryClient with expectAuth: true', () => {
    expect(source).toContain('ConvexQueryClient');
    expect(source).toContain('expectAuth');
  });

  it('connects ConvexQueryClient to query client', () => {
    expect(source).toContain('convexQueryClient');
  });

  it('does not use raw ConvexReactClient', () => {
    // Should use ConvexQueryClient, not the raw client
    const hasRawClient = /new\s+ConvexReactClient/.test(source);
    expect(hasRawClient).toBe(false);
  });

  it('does not wrap the tree in a plain ConvexProvider when protected routes use ConvexBetterAuthProvider', () => {
    expect(rootSource).not.toContain('ConvexBetterAuthProvider');
    expect(source).not.toContain('<ConvexProvider');
  });
});

describe('Auth configuration: auth-server token caching', () => {
  const source = readSource('lib/auth-server.ts');

  it('enables jwtCache for server-side token fetches', () => {
    expect(source).toContain('jwtCache');
    expect(source).toContain('enabled: true');
  });

  it('passes the Better Auth cookie prefix into token caching', () => {
    expect(source).toContain('cookiePrefix');
    expect(source).toContain("'yucp'");
  });
});
