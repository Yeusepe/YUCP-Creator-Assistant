import { describe, expect, it } from 'bun:test';
import { rewriteOAuthAuthorizationServerMetadata } from './oauthDiscovery';

describe('rewriteOAuthAuthorizationServerMetadata', () => {
  it('rewrites published OAuth endpoints to the request origin while preserving the issuer', () => {
    const metadata = rewriteOAuthAuthorizationServerMetadata(
      {
        issuer: 'https://rare-squid-409.convex.site/api/auth',
        authorization_endpoint: 'http://localhost:3000/api/auth/oauth2/authorize',
        token_endpoint: 'http://localhost:3000/api/auth/oauth2/token',
        registration_endpoint: 'http://localhost:3000/api/auth/oauth2/register',
        introspection_endpoint: 'http://localhost:3000/api/auth/oauth2/introspect',
        revocation_endpoint: 'http://localhost:3000/api/auth/oauth2/revoke',
        jwks_uri: 'http://localhost:3000/api/auth/jwks',
      },
      new Request('https://dsktp.tailc472f7.ts.net/.well-known/oauth-authorization-server/api/auth')
    );

    expect(metadata).toMatchObject({
      issuer: 'https://rare-squid-409.convex.site/api/auth',
      authorization_endpoint: 'https://dsktp.tailc472f7.ts.net/api/auth/oauth2/authorize',
      token_endpoint: 'https://dsktp.tailc472f7.ts.net/api/auth/oauth2/token',
      registration_endpoint: 'https://dsktp.tailc472f7.ts.net/api/auth/oauth2/register',
      introspection_endpoint: 'https://dsktp.tailc472f7.ts.net/api/auth/oauth2/introspect',
      revocation_endpoint: 'https://dsktp.tailc472f7.ts.net/api/auth/oauth2/revoke',
      jwks_uri: 'https://dsktp.tailc472f7.ts.net/api/auth/jwks',
    });
  });
});
