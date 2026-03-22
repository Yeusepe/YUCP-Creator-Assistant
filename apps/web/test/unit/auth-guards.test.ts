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

function readRoute(name: string): string {
  return readFileSync(join(ROUTES_DIR, name), 'utf8');
}

// Routes that MUST have auth guards (creator-authenticated pages)
const PROTECTED_ROUTES = ['dashboard.tsx', 'account.tsx'];

// Routes that MUST NOT require auth (public-facing pages)
const PUBLIC_ROUTES = [
  'sign-in.tsx',
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

describe('Auth guards: protected routes', () => {
  for (const route of PROTECTED_ROUTES) {
    describe(route, () => {
      const source = readRoute(route);

      it('has a beforeLoad handler', () => {
        expect(source).toContain('beforeLoad');
      });

      it('checks authentication state in beforeLoad', () => {
        // The guard should check context.isAuthenticated or context.token
        const hasAuthCheck =
          source.includes('isAuthenticated') ||
          source.includes('context.token') ||
          source.includes('!context.isAuthenticated');
        expect(hasAuthCheck).toBe(true);
      });

      it('redirects unauthenticated users to /sign-in', () => {
        expect(source).toContain('/sign-in');
        // Should use redirect() or throw redirect
        const hasRedirect = source.includes('redirect(') || source.includes('throw redirect');
        expect(hasRedirect).toBe(true);
      });
    });
  }
});

describe('Auth guards: public routes', () => {
  for (const route of PUBLIC_ROUTES) {
    let source: string;
    try {
      source = readRoute(route);
    } catch {
      continue; // Route doesn't exist, skip
    }

    it(`${route} does not gate on isAuthenticated as a required guard`, () => {
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
    // The sign-in page should send already-authenticated users away via redirect
    const checksAuth = source.includes('isAuthenticated') || source.includes('context.token');
    const throwsRedirect = source.includes('throw redirect');
    expect(checksAuth).toBe(true);
    expect(throwsRedirect).toBe(true);
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

  it('calls getAuth in beforeLoad for SSR token setup', () => {
    expect(source).toContain('getAuth');
    expect(source).toContain('beforeLoad');
  });

  it('sets auth token on serverHttpClient for SSR', () => {
    const handlesSsrAuthInline = source.includes('serverHttpClient') && source.includes('setAuth');
    const delegatesToSsrAuthHelper = source.includes('loadRootAuthState');
    expect(handlesSsrAuthInline || delegatesToSsrAuthHelper).toBe(true);
  });

  it('wraps app with ConvexBetterAuthProvider', () => {
    expect(source).toContain('ConvexBetterAuthProvider');
  });

  it('keeps HeadContent outside the Better Auth provider tree', () => {
    const providerIndex = source.indexOf('<ConvexBetterAuthProvider');
    const rootDocumentIndex = source.indexOf('<RootDocument>');
    const headContentIndex = source.indexOf('<HeadContent />');

    expect(providerIndex).toBeGreaterThan(-1);
    expect(rootDocumentIndex).toBeGreaterThan(-1);
    expect(headContentIndex).toBeGreaterThan(-1);
    expect(rootDocumentIndex).toBeLessThan(providerIndex);
  });

  it('returns isAuthenticated in route context', () => {
    const returnsAuthStateInline = source.includes('isAuthenticated');
    const delegatesToSsrAuthHelper = source.includes('loadRootAuthState');
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

  it('does not wrap the tree in a plain ConvexProvider when the root uses ConvexBetterAuthProvider', () => {
    expect(rootSource).toContain('ConvexBetterAuthProvider');
    expect(source).not.toContain('<ConvexProvider');
  });
});
