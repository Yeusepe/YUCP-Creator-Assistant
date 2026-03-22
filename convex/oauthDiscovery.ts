import type { GenericCtx } from '@convex-dev/better-auth';
import type { DataModel } from './_generated/dataModel';
import { createAuth } from './auth';

interface BetterAuthOAuthDiscoveryApi {
  getOAuthServerConfig(): Promise<unknown>;
}

type OAuthAuthorizationServerMetadata = Record<string, unknown> & {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  introspection_endpoint?: string;
  revocation_endpoint?: string;
  jwks_uri?: string;
};

function rewriteEndpointUrl(
  origin: string,
  fallbackPath: string,
  value: unknown
): string | undefined {
  const candidate =
    typeof value === 'string' && value.length > 0
      ? new URL(value).pathname + new URL(value).search
      : fallbackPath;
  return new URL(candidate, origin).toString();
}

export function rewriteOAuthAuthorizationServerMetadata(
  metadata: unknown,
  request: Request
): OAuthAuthorizationServerMetadata {
  const body = { ...(metadata as OAuthAuthorizationServerMetadata) };
  const origin = new URL(request.url).origin;

  body.authorization_endpoint = rewriteEndpointUrl(
    origin,
    '/api/auth/oauth2/authorize',
    body.authorization_endpoint
  );
  body.token_endpoint = rewriteEndpointUrl(origin, '/api/auth/oauth2/token', body.token_endpoint);
  body.registration_endpoint = rewriteEndpointUrl(
    origin,
    '/api/auth/oauth2/register',
    body.registration_endpoint
  );
  body.introspection_endpoint = rewriteEndpointUrl(
    origin,
    '/api/auth/oauth2/introspect',
    body.introspection_endpoint
  );
  body.revocation_endpoint = rewriteEndpointUrl(
    origin,
    '/api/auth/oauth2/revoke',
    body.revocation_endpoint
  );
  body.jwks_uri = rewriteEndpointUrl(origin, '/api/auth/jwks', body.jwks_uri);

  return body;
}

export async function handleOAuthAuthorizationServerMetadata(
  ctx: GenericCtx<DataModel>,
  request: Request
): Promise<Response> {
  const auth = createAuth(ctx);
  const api = auth.api as unknown as BetterAuthOAuthDiscoveryApi;
  const body = rewriteOAuthAuthorizationServerMetadata(await api.getOAuthServerConfig(), request);

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Cache-Control': 'public, max-age=15, stale-while-revalidate=15, stale-if-error=86400',
      'Content-Type': 'application/json',
    },
  });
}
