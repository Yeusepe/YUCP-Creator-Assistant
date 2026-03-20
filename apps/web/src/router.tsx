import { ConvexQueryClient } from '@convex-dev/react-query';
import { notifyManager, QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  if (typeof document !== 'undefined') {
    notifyManager.setScheduler(window.requestAnimationFrame);
  }

  const convexUrl = import.meta.env.CONVEX_URL as string | undefined;
  if (!convexUrl) {
    throw new Error('CONVEX_URL is not available. Ensure it is set in your Infisical environment.');
  }

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
