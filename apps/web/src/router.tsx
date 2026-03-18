import { QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { ConvexReactClient } from 'convex/react';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  const convexUrl = import.meta.env.CONVEX_URL as string | undefined;
  if (!convexUrl) {
    throw new Error('CONVEX_URL is not available. Ensure it is set in your Infisical environment.');
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
