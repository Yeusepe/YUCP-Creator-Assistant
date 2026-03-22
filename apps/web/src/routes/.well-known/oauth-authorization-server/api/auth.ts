import { createFileRoute } from '@tanstack/react-router';
import { proxyOAuthAuthorizationServerMetadata } from '@/lib/server/oauthDiscovery';

export const Route = createFileRoute('/.well-known/oauth-authorization-server/api/auth')({
  server: {
    handlers: {
      GET: ({ request }) => proxyOAuthAuthorizationServerMetadata(request),
    },
  },
});
