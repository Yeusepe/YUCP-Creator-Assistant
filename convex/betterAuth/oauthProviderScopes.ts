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
export const PACKAGE_BROKER_OPERATION_SCOPE = 'package:operate';

// Native clients can legitimately retry a rotated token when the first
// response is lost. Better Auth replays only the same response for the same
// client, scopes, resources, and sender constraint during this bounded window.
// https://better-auth.com/docs/plugins/oauth-provider#refresh-token-grant
// https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14.2
export const OAUTH_NATIVE_REFRESH_TOKEN_REUSE_INTERVAL_SECONDS = 30;

export interface AuthorizationServerTimeFields {
  [key: string]: unknown;
  authorization_server_time: number;
}

/**
 * Better Auth explicitly supports adding non-standard fields beside the
 * standard OAuth token response fields through `customTokenResponseFields`.
 * The native client uses this whole-second server timestamp as its trusted
 * clock anchor while retaining the provider's normal token expiry fields.
 *
 * https://better-auth.com/docs/beta/plugins/oauth-provider#custom-token-response-fields
 */
export function authorizationServerTimeFields(): AuthorizationServerTimeFields {
  return {
    authorization_server_time: Math.floor(Date.now() / 1000),
  };
}

export type OAuthProviderScope =
  | PublicApiScope
  | typeof OAUTH_REFRESH_TOKEN_SCOPE
  | typeof PACKAGE_BROKER_OPERATION_SCOPE;

export const OAUTH_PROVIDER_SCOPES = [
  ...PUBLIC_API_SCOPES,
  PACKAGE_BROKER_OPERATION_SCOPE,
  OAUTH_REFRESH_TOKEN_SCOPE,
] as const satisfies readonly OAuthProviderScope[];
