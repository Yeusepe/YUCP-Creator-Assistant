import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const showPageMock = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({
    options,
    useSearch: () => ({ redirectTo: undefined }),
  }),
  createLazyFileRoute: () => (options: unknown) => ({ options }),
  createRootRouteWithContext: () => (options: unknown) => ({
    options,
    useLoaderData: () => ({ requestUrl: 'https://app.example.com/' }),
  }),
  HeadContent: () => null,
  Outlet: () => <div data-testid="route-outlet" />,
  redirect: vi.fn(),
  Scripts: () => null,
  useRouterState: () => ({
    location: { href: 'https://app.example.com/', pathname: '/' },
  }),
}));

vi.mock('@/components/three/CloudBackground', () => ({
  CloudBackground: () => <div data-testid="cloud-background" />,
  CloudBackgroundLayer: () => <div data-testid="cloud-background-layer" />,
}));

vi.mock('@/components/ui/CookiePreferencesPrompt', () => ({
  CookiePreferencesPrompt: () => null,
}));

vi.mock('@/components/ui/Toast', () => ({
  ToastProvider: ({ children }: PropsWithChildren) => <>{children}</>,
}));

vi.mock('@/hooks/usePageLoadingTransition', () => ({
  usePageLoadingTransition: () => showPageMock,
}));

vi.mock('@/lib/account', () => ({
  startAccountRecovery: vi.fn(),
  verifyAccountRecoveryBackupCode: vi.fn(),
  verifyAccountRecoveryEmail: vi.fn(),
}));

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    getSession: vi.fn(),
    passkey: { addPasskey: vi.fn() },
    signIn: { passkey: vi.fn(), social: vi.fn() },
  },
}));

vi.mock('@/lib/chunkErrorRecovery', () => ({
  installChunkErrorRecovery: vi.fn(),
}));

vi.mock('@/lib/hyperdx', () => ({
  addHyperdxActionWithNumbers: vi.fn(),
  initializeHyperdxBrowser: vi.fn(),
  setHyperdxGlobalAttributes: vi.fn(),
}));

vi.mock('@/lib/server/runtimeConfig', () => ({
  getDocumentRequestUrl: vi.fn(async () => 'https://app.example.com/'),
}));

vi.mock('@/lib/versionPoller', () => ({
  useVersionPoller: vi.fn(),
}));

vi.mock('@/lib/webDiagnostics', () => ({
  logRootRenderError: vi.fn(),
  logWebError: vi.fn(),
}));

import { Route as RootRoute } from '@/routes/__root';
import { Route as OAuthConsentRoute } from '@/routes/oauth/consent.lazy';
import { SignInPage } from '@/routes/sign-in';

type TestRoute = {
  options: {
    component?: React.ComponentType;
  };
};

const LAZY_ROUTE_PAIRS = [
  [() => import('@/routes/setup/jinxxy'), () => import('@/routes/setup/jinxxy.lazy')],
  [() => import('@/routes/setup/lemonsqueezy'), () => import('@/routes/setup/lemonsqueezy.lazy')],
  [() => import('@/routes/setup/payhip'), () => import('@/routes/setup/payhip.lazy')],
  [() => import('@/routes/setup/vrchat'), () => import('@/routes/setup/vrchat.lazy')],
  [() => import('@/routes/oauth/consent'), () => import('@/routes/oauth/consent.lazy')],
  [() => import('@/routes/install/success'), () => import('@/routes/install/success.lazy')],
  [() => import('@/routes/install/error'), () => import('@/routes/install/error.lazy')],
  [
    () => import('@/routes/_authenticated/verify/purchase'),
    () => import('@/routes/_authenticated/verify/purchase.lazy'),
  ],
] as const;

describe('initial load behavior', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('leaves decorative clouds out of the universal root shell', () => {
    const Component = (RootRoute as TestRoute).options.component;
    if (!Component) {
      throw new Error('Root route component is not defined');
    }

    const markup = renderToStaticMarkup(<Component />);

    expect(markup).toContain('data-testid="route-outlet"');
    expect(markup).not.toContain('data-testid="cloud-background"');
    expect(markup).not.toContain('data-testid="cloud-background-layer"');
  });

  it('owns the toast provider at the document boundary shared by normal and error renders', () => {
    const source = readFileSync(resolve(__dirname, '../../src/routes/__root.tsx'), 'utf8');
    const rootDocument = source.match(
      /function RootDocument\([\s\S]+?\n\}\n\nfunction resolveDocumentRuntimeConfig/u
    )?.[0];

    expect(rootDocument).toContain('<ToastProvider>');
    expect(rootDocument).toContain('</ToastProvider>');
  });

  it('keeps toast context identity outside the hot-reloaded toast renderer module', () => {
    const toastRenderer = readFileSync(
      resolve(__dirname, '../../src/components/ui/Toast.tsx'),
      'utf8'
    );

    expect(toastRenderer).not.toContain('createContext');
    expect(toastRenderer).not.toContain('useContext');
    expect(toastRenderer).not.toContain('export function useToast');
    expect(toastRenderer).toContain("from '@/components/ui/toastContext'");
  });

  it('shows the sign-in shell without waiting for the decorative cloud to report ready', () => {
    render(<SignInPage />);

    expect(screen.getByTestId('cloud-background')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    expect(showPageMock).toHaveBeenCalled();
  });

  it('renders OAuth consent with its current canvas background host', () => {
    const Component = (OAuthConsentRoute as TestRoute).options.component;
    if (!Component) {
      throw new Error('OAuth consent route component is not defined');
    }

    render(<Component />);

    expect(screen.getByTestId('cloud-background-layer')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Authorize application' })).toBeVisible();
  });

  it('keeps CSS-heavy screens in lazy route companions at runtime', async () => {
    for (const [loadRoute, loadLazyRoute] of LAZY_ROUTE_PAIRS) {
      const [routeModule, lazyRouteModule] = await Promise.all([loadRoute(), loadLazyRoute()]);
      const route = routeModule.Route as TestRoute;
      const lazyRoute = lazyRouteModule.Route as TestRoute;

      expect(route.options.component).toBeUndefined();
      expect(lazyRoute.options.component).toEqual(expect.any(Function));
    }
  });
});
