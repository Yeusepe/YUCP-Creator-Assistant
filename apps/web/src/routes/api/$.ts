import { createFileRoute } from '@tanstack/react-router';
import { proxyApiRequest } from '@/lib/server/api-proxy';

export const Route = createFileRoute('/api/$')({
  server: {
    handlers: {
      GET: ({ request }) => proxyApiRequest(request),
      POST: ({ request }) => proxyApiRequest(request),
      PUT: ({ request }) => proxyApiRequest(request),
      PATCH: ({ request }) => proxyApiRequest(request),
      DELETE: ({ request }) => proxyApiRequest(request),
    },
  },
});
