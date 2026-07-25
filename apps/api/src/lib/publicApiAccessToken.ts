import { PUBLIC_API_AUDIENCE } from '@yucp/shared';
import {
  type VerifyOAuthAccessTokenOptions,
  type VerifyOAuthAccessTokenResult,
  verifyBetterAuthAccessToken,
} from './oauthAccessToken';

export type VerifyPublicApiAccessTokenOptions = Omit<VerifyOAuthAccessTokenOptions, 'audience'>;

/**
 * Verify a token for the public API protected resource.
 *
 * Better Auth uses the requested resource URI as the JWT audience.
 * https://better-auth.com/docs/plugins/oauth-provider#jwt-verification
 */
export function verifyPublicApiAccessToken(
  token: string,
  options: VerifyPublicApiAccessTokenOptions
): Promise<VerifyOAuthAccessTokenResult> {
  return verifyBetterAuthAccessToken(token, {
    ...options,
    audience: PUBLIC_API_AUDIENCE,
  });
}
