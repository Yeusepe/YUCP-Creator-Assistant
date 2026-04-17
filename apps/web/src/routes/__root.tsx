/// <reference types="vite/client" />

import type { ConvexQueryClient } from '@convex-dev/react-query';
import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
  useRouterState,
} from '@tanstack/react-router';
import { type ReactNode, useEffect, useRef } from 'react';
import { CookiePreferencesPrompt } from '@/components/ui/CookiePreferencesPrompt';
import { ToastProvider } from '@/components/ui/Toast';
import { installChunkErrorRecovery } from '@/lib/chunkErrorRecovery';
import {
  addHyperdxActionWithNumbers,
  initializeHyperdxBrowser,
  setHyperdxGlobalAttributes,
} from '@/lib/hyperdx';
import {
  buildPublicRuntimeEnvSource,
  createPublicRuntimeConfigFromEnv,
  getPublicRuntimeConfig,
  RuntimeConfigProvider,
  serializePublicRuntimeConfig,
} from '@/lib/runtimeConfig';
import { getDocumentRequestUrl } from '@/lib/server/runtimeConfig';
import { getWebEnv, getWebRuntimeEnv } from '@/lib/server/runtimeEnv';
import { useVersionPoller } from '@/lib/versionPoller';
import { logRootRenderError } from '@/lib/webDiagnostics';

import '@/styles/tokens.css';
import '@/styles/loading.css';
import '@/styles/globals.css';
import '@/styles/toast.css';

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  convexQueryClient: ConvexQueryClient;
}>()({
  loader: async () => ({
    requestUrl: await getDocumentRequestUrl(),
  }),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Creator Assistant' },
      {
        name: 'description',
        content:
          'Manage your Discord server integrations, verification, and creator tools with Creator Assistant.',
      },
    ],
    links: [{ rel: 'icon', href: '/Icons/favicon.ico', type: 'image/x-icon' }],
  }),
  component: RootComponent,
  errorComponent: RootErrorComponent,
});

function RootComponent() {
  const { requestUrl } = Route.useLoaderData();
  const runtimeConfig = resolveDocumentRuntimeConfig(requestUrl);

  return (
    <RootDocument runtimeConfig={runtimeConfig}>
      <RuntimeConfigProvider value={runtimeConfig}>
        <ToastProvider>
          <AppEffects />
          <Outlet />
          <CookiePreferencesPrompt />
        </ToastProvider>
      </RuntimeConfigProvider>
    </RootDocument>
  );
}

/** Mounts global client-side effects that require React context. */
function AppEffects() {
  const routerState = useRouterState();
  const lastRouteKeyRef = useRef<string | null>(null);

  useEffect(() => {
    installChunkErrorRecovery();
    initializeHyperdxBrowser();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const routeKey = routerState.location.href;
    if (lastRouteKeyRef.current === routeKey) {
      return;
    }

    lastRouteKeyRef.current = routeKey;
    const searchParamCount = new URL(routeKey, window.location.origin).searchParams.size;
    setHyperdxGlobalAttributes({
      route: routerState.location.pathname,
      searchParamCount,
    });
    addHyperdxActionWithNumbers('route.view', {
      route: routerState.location.pathname,
      searchParamCount,
      hasHash: window.location.hash.length > 1,
    });
  }, [routerState.location.href, routerState.location.pathname]);

  useVersionPoller();

  return null;
}

function RootDocument({
  children,
  runtimeConfig,
}: Readonly<{
  children: ReactNode;
  runtimeConfig: ReturnType<typeof resolveDocumentRuntimeConfig>;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Blocking script: runs before first paint to apply the stored theme.
            Must precede HeadContent so the class is set before any CSS renders. */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: intentional blocking inline script for theme hydration
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('yucp_theme');if(t==='dark'||(t===null&&matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark')}}catch(e){}`,
          }}
        />
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: the Worker injects request-scoped public runtime config for the browser bundle
          dangerouslySetInnerHTML={{
            __html: `window.__YUCP_PUBLIC_RUNTIME_CONFIG__=${serializePublicRuntimeConfig(runtimeConfig)};`,
          }}
        />
        <HeadContent />
      </head>
      <body>
        {children}
        <div id="portal-root" className="portal-root" />
        <Scripts />
      </body>
    </html>
  );
}

function resolveDocumentRuntimeConfig(requestUrl?: string) {
  if (typeof document !== 'undefined') {
    return getPublicRuntimeConfig();
  }

  return getPublicRuntimeConfigFromServerEnv(requestUrl);
}

function getPublicRuntimeConfigFromServerEnv(requestUrl?: string) {
  const env = getWebRuntimeEnv();

  return createPublicRuntimeConfigFromEnv(
    buildPublicRuntimeEnvSource((key) => getWebEnv(key, env)),
    requestUrl
  );
}

function RootErrorComponent({ error }: { error: Error }) {
  const requestUrl = Route.useLoaderData({ select: (data) => data.requestUrl });

  logRootRenderError(error, {
    route: typeof window !== 'undefined' ? window.location.pathname : undefined,
  });

  return (
    <RootDocument runtimeConfig={resolveDocumentRuntimeConfig(requestUrl)}>
      <div
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: '24px',
          background: 'var(--bg-primary)',
          color: 'var(--text-primary)',
        }}
      >
        <div
          style={{
            width: 'min(560px, 100%)',
            borderRadius: '20px',
            border: '1px solid rgba(255,255,255,0.08)',
            background: 'rgba(255,255,255,0.03)',
            padding: '28px',
          }}
        >
          <h1 style={{ margin: '0 0 12px', fontSize: '28px' }}>Something went wrong</h1>
          <p style={{ margin: '0 0 20px', color: 'rgba(255,255,255,0.72)' }}>
            The app hit an unexpected error while rendering this page.
          </p>
          <pre
            style={{
              margin: '0 0 24px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'rgba(255,255,255,0.76)',
            }}
          >
            {error.message}
          </pre>
          <iframe
            src="https://status.yucp.club/embed/events/live?theme=dark&incidents=1&maintenance=1&tags=creator-assistant-api%2Ccreator-assistant-dashboard%2Ccreator-assistant-backend%2Ccreator-assistant-state%2Ccreator-assistant-discord-bot"
            title="Creator Assistant status"
            width="100%"
            height="300"
            frameBorder="0"
            allowFullScreen
            style={{ borderRadius: '10px', display: 'block' }}
          />
        </div>
      </div>
    </RootDocument>
  );
}
