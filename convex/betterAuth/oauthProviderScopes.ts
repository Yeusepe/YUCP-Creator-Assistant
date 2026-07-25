import {
  type PublicApiScope,
  PUBLIC_API_SCOPES,
} from '@yucp/shared';

// `offline_access` is the standard OIDC scope Better Auth uses to issue
// refresh tokens for authorization-code clients.
// References:
// - https://better-auth.com/docs/plugins/oauth-provider
// - https://openid.net/specs/openid-connect-basic-1_0.html#Scopes
export const OAUTH_REFRESH_TOKEN_SCOPE = 'offline_access';

export type OAuthProviderScope = PublicApiScope | typeof OAUTH_REFRESH_TOKEN_SCOPE;

export const OAUTH_PROVIDER_SCOPES = [
  ...PUBLIC_API_SCOPES,
  OAUTH_REFRESH_TOKEN_SCOPE,
] as const satisfies readonly OAuthProviderScope[];
