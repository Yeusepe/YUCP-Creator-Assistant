import { ConvexQueryClient } from '@convex-dev/react-query';
import { notifyManager, QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';
import { getPublicRuntimeConfig } from '@/lib/runtimeConfig';
import { getWebEnv, getWebRuntimeEnv } from '@/lib/server/runtimeEnv';
import { resolveRequiredConvexUrl } from '@/lib/webDiagnostics';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  if (typeof document !== 'undefined') {
    notifyManager.setScheduler(window.requestAnimationFrame);
  }

  const publicRuntimeConfig = typeof window !== 'undefined' ? getPublicRuntimeConfig() : undefined;
  const runtimeEnv = typeof window === 'undefined' ? getWebRuntimeEnv() : undefined;
  const readServerEnv = (name: 'CONVEX_URL' | 'CONVEX_SITE_URL' | 'NODE_ENV') =>
    runtimeEnv ? getWebEnv(name, runtimeEnv) : undefined;
  const configuredConvexUrl = publicRuntimeConfig?.convexUrl ?? readServerEnv('CONVEX_URL');

  const convexUrl = resolveRequiredConvexUrl(configuredConvexUrl, {
    env: {
      NODE_ENV: import.meta.env.MODE ?? readServerEnv('NODE_ENV'),
      CONVEX_URL: configuredConvexUrl,
      CONVEX_SITE_URL: publicRuntimeConfig?.convexSiteUrl ?? readServerEnv('CONVEX_SITE_URL'),
    },
  });

  const convexQueryClient = new ConvexQueryClient(convexUrl, {
    expectAuth: true,
  });

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        queryKeyHashFn: convexQueryClient.hashFn(),
        queryFn: convexQueryClient.queryFn(),
      },
    },
  });
  convexQueryClient.connect(queryClient);

  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPendingMs: 0,
    defaultPendingMinMs: 200,
    parseSearch: (search) => {
      const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
      return Object.fromEntries(params.entries());
    },
    stringifySearch: (search) => {
      const params = new URLSearchParams();

      for (const [key, value] of Object.entries(search)) {
        if (value === undefined || value === null || value === '') {
          continue;
        }

        if (Array.isArray(value)) {
          for (const entry of value) {
            params.append(key, String(entry));
          }
          continue;
        }

        params.set(key, String(value));
      }

      const serialized = params.toString();
      return serialized ? `?${serialized}` : '';
    },
    context: { queryClient, convexQueryClient },
  });

  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
