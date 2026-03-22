import { createFileRoute } from '@tanstack/react-router';
import { handleAuthRequest } from '@/lib/auth-server';

/**
 * Catch-all route that proxies all /api/auth/* requests
 * directly to Convex via the Better Auth handler.
 *
 * POST redirect responses (e.g. from /api/auth/oauth2/consent) are converted
 * to JSON { redirectTo } so JS clients can navigate programmatically.
 * See auth-server.ts#convertPostRedirectToJson for the full explanation.
 *
 * This is the official pattern from:
 * https://labs.convex.dev/better-auth/framework-guides/tanstack-start
 */
export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => handleAuthRequest(request),
      POST: ({ request }) => handleAuthRequest(request),
    },
  },
});
