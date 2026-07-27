import { PUBLIC_API_AUDIENCE } from '@yucp/shared';

/**
 * Better Auth issues a JWT when the client requests a registered resource.
 * https://better-auth.com/docs/plugins/oauth-provider#token-endpoint
 */
export function bindDefaultOAuthResource(body: URLSearchParams): URLSearchParams {
  const boundBody = new URLSearchParams(body);
  if (!boundBody.has('resource')) {
    boundBody.set('resource', PUBLIC_API_AUDIENCE);
  }
  return boundBody;
}
