import { createFileRoute } from '@tanstack/react-router';
import { handler } from '@/lib/auth-server';

/**
 * Catch-all route that proxies all /api/auth/* requests
 * directly to Convex via the Better Auth handler.
 *
 * This is the official pattern from:
 * https://labs.convex.dev/better-auth/framework-guides/tanstack-start
 */
export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => handler(request),
      POST: ({ request }) => handler(request),
    },
  },
});
