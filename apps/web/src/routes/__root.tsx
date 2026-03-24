/// <reference types="vite/client" />

import { ConvexBetterAuthProvider } from '@convex-dev/better-auth/react';
import type { ConvexQueryClient } from '@convex-dev/react-query';
import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
  useRouteContext,
} from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { type ReactNode, useEffect, useState } from 'react';
import { PageLoadingOverlay } from '@/components/page/PageLoadingOverlay';
import { CloudBackground } from '@/components/three/CloudBackground';
import { ToastProvider } from '@/components/ui/Toast';
import { CloudReadyContext } from '@/hooks/useCloudReady';
import { authClient } from '@/lib/auth-client';
import { collectAuthRuntimeDiagnostics, getToken } from '@/lib/auth-server';
import { installChunkErrorRecovery } from '@/lib/chunkErrorRecovery';
import { useVersionPoller } from '@/lib/versionPoller';
import { loadRootAuthState, logRootRenderError, logWebError } from '@/lib/webDiagnostics';

import '@/styles/tokens.css';
import '@/styles/loading.css';
import '@/styles/globals.css';
import '@/styles/toast.css';

/**
 * Server function to retrieve the auth token during SSR.
 * Called in beforeLoad so the initial HTML render is authenticated.
 */
const getAuth = createServerFn({ method: 'GET' }).handler(async () => {
  console.info('[web] Root auth server function started', {
    phase: 'root-getAuth-serverFn',
  });

  try {
    const token = await getToken();

    console.info('[web] Root auth server function completed', {
      phase: 'root-getAuth-serverFn',
      hasToken: Boolean(token),
    });

    return token;
  } catch (error) {
    try {
      logWebError('Root auth server function failed', error, {
        phase: 'root-getAuth-serverFn',
        ...(await collectAuthRuntimeDiagnostics()),
      });
    } catch (diagnosticError) {
      logWebError('Root auth server function diagnostics failed', diagnosticError, {
        phase: 'root-getAuth-serverFn',
      });
    }

    throw error;
  }
});

/**
 * Cached auth state for client-side navigations.
 *
 * beforeLoad has no staleTime — it runs on every navigation. On the server
 * (SSR) we must always fetch a fresh token, but on the client the token is
 * only needed once (for ConvexBetterAuthProvider's initialToken during
 * hydration). After that, better-auth / Convex manage auth state internally
 * via the WebSocket connection. Caching here prevents a server round-trip on
 * every tab switch.
 */
let _clientRootAuthCache: import('@/lib/webDiagnostics').RootAuthState | null = null;

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  convexQueryClient: ConvexQueryClient;
}>()({
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
    links: [
      { rel: 'icon', href: '/Icons/favicon.ico', type: 'image/x-icon' },
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      {
        rel: 'preconnect',
        href: 'https://fonts.gstatic.com',
        crossOrigin: 'anonymous',
      },
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=DM+Sans:ital,wght@0,400;0,500;0,700;1,400&display=swap',
      },
    ],
  }),
  beforeLoad: async (ctx) => {
    if (typeof window !== 'undefined' && _clientRootAuthCache !== null) {
      return _clientRootAuthCache;
    }
    const state = await loadRootAuthState({
      convexQueryClient: ctx.context.convexQueryClient,
      location: ctx.location,
      getAuthToken: () => getAuth(),
    });
    if (typeof window !== 'undefined') {
      _clientRootAuthCache = state;
    }
    return state;
  },
  component: RootComponent,
  errorComponent: RootErrorComponent,
});

function RootComponent() {
  const context = useRouteContext({ from: Route.id });
  const [bgReady, setBgReady] = useState(false);
  return (
    <RootDocument>
      <ConvexBetterAuthProvider
        client={context.convexQueryClient.convexClient}
        authClient={authClient}
        initialToken={context.token}
      >
        <CloudReadyContext.Provider value={bgReady}>
          <PageLoadingOverlay />
          <CloudBackground variant="default" onReady={() => setBgReady(true)} />
          <ToastProvider>
            <AppEffects />
            <Outlet />
          </ToastProvider>
        </CloudReadyContext.Provider>
      </ConvexBetterAuthProvider>
    </RootDocument>
  );
}

/** Mounts global client-side effects that require React context. */
function AppEffects() {
  useEffect(() => {
    installChunkErrorRecovery();
  }, []);

  useVersionPoller();

  return null;
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
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
        <HeadContent />
      </head>
      <body>
        {children}
        <div id="portal-root" />
        <Scripts />
      </body>
    </html>
  );
}

function RootErrorComponent({ error }: { error: Error }) {
  logRootRenderError(error, {
    route: typeof window !== 'undefined' ? window.location.pathname : undefined,
  });

  return (
    <RootDocument>
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
