import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rootRouteSource = readFileSync(resolve(__dirname, '../../src/routes/__root.tsx'), 'utf8');
const signInRouteSource = readFileSync(resolve(__dirname, '../../src/routes/sign-in.tsx'), 'utf8');
const signInRedirectRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/sign-in-redirect.tsx'),
  'utf8'
);
const oauthLoginRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/oauth/login.tsx'),
  'utf8'
);
const oauthConsentLazyRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/oauth/consent.lazy.tsx'),
  'utf8'
);
const dashboardLazyRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/dashboard.lazy.tsx'),
  'utf8'
);
const accountLazyRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/account.lazy.tsx'),
  'utf8'
);

const lazyRoutePairs = [
  {
    routeSource: resolve(__dirname, '../../src/routes/setup/jinxxy.tsx'),
    lazyRouteSource: resolve(__dirname, '../../src/routes/setup/jinxxy.lazy.tsx'),
    styleImports: ["import '@/styles/jinxxy-setup.css';"],
  },
  {
    routeSource: resolve(__dirname, '../../src/routes/setup/lemonsqueezy.tsx'),
    lazyRouteSource: resolve(__dirname, '../../src/routes/setup/lemonsqueezy.lazy.tsx'),
    styleImports: ["import '@/styles/lemonsqueezy-setup.css';"],
  },
  {
    routeSource: resolve(__dirname, '../../src/routes/setup/payhip.tsx'),
    lazyRouteSource: resolve(__dirname, '../../src/routes/setup/payhip.lazy.tsx'),
    styleImports: ["import '@/styles/payhip-setup.css';"],
  },
  {
    routeSource: resolve(__dirname, '../../src/routes/setup/vrchat.tsx'),
    lazyRouteSource: resolve(__dirname, '../../src/routes/setup/vrchat.lazy.tsx'),
    styleImports: ["import '@/styles/vrchat-verify.css';"],
  },
  {
    routeSource: resolve(__dirname, '../../src/routes/oauth/consent.tsx'),
    lazyRouteSource: resolve(__dirname, '../../src/routes/oauth/consent.lazy.tsx'),
    styleImports: ["import '@/styles/oauth-consent.css';"],
  },
  {
    routeSource: resolve(__dirname, '../../src/routes/install/success.tsx'),
    lazyRouteSource: resolve(__dirname, '../../src/routes/install/success.lazy.tsx'),
    styleImports: ["import '@/styles/install-result.css';"],
  },
  {
    routeSource: resolve(__dirname, '../../src/routes/install/error.tsx'),
    lazyRouteSource: resolve(__dirname, '../../src/routes/install/error.lazy.tsx'),
    styleImports: ["import '@/styles/install-result.css';"],
  },
  {
    routeSource: resolve(__dirname, '../../src/routes/_authenticated/verify/purchase.tsx'),
    lazyRouteSource: resolve(__dirname, '../../src/routes/_authenticated/verify/purchase.lazy.tsx'),
    styleImports: ["import '@/styles/verify-purchase.css';"],
  },
] as const;

describe('initial load architecture', () => {
  it('keeps the decorative cloud background off the universal root startup path', () => {
    expect(rootRouteSource).not.toContain('import { CloudBackground }');
    expect(rootRouteSource).not.toContain('<CloudBackground');
  });

  it('mounts cloud backgrounds only in the routes that intentionally gate their reveal behind it', () => {
    for (const source of [
      signInRouteSource,
      signInRedirectRouteSource,
      oauthLoginRouteSource,
      oauthConsentLazyRouteSource,
      dashboardLazyRouteSource,
      accountLazyRouteSource,
    ]) {
      expect(source).toContain('CloudBackground');
    }
  });

  it('does not block auth entry shells on cloud background readiness', () => {
    for (const source of [signInRouteSource, signInRedirectRouteSource, oauthLoginRouteSource]) {
      expect(source).not.toContain('useCloudReady');
      expect(source).not.toContain('CloudReadyContext.Provider');
      expect(source).not.toContain('if (bgReady) showPage()');
    }
  });

  it('keeps remaining css-heavy routes in lazy companion files instead of the route references', () => {
    for (const pair of lazyRoutePairs) {
      const routeSource = readFileSync(pair.routeSource, 'utf8');
      const lazyRouteSource = readFileSync(pair.lazyRouteSource, 'utf8');

      expect(routeSource).toContain('createFileRoute');
      expect(lazyRouteSource).toContain('createLazyFileRoute');

      for (const styleImport of pair.styleImports) {
        expect(routeSource).not.toContain(styleImport);
        expect(lazyRouteSource).toContain(styleImport);
      }
    }
  });
});
