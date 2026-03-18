import { QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { ConvexReactClient } from 'convex/react';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  const convexUrl = (import.meta as unknown as { env: Record<string, string> }).env.VITE_CONVEX_URL;
  if (!convexUrl) {
    throw new Error('VITE_CONVEX_URL is not set. Add it to your .env.local file.');
  }

  const convexClient = new ConvexReactClient(convexUrl);

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 1000 * 60 * 5,
        retry: 1,
      },
    },
  });

  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    context: {
      queryClient,
      convexClient,
    },
  });

  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
