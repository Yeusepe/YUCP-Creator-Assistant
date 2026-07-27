import { PACKAGE_BROKER_AUDIENCE } from '@yucp/shared';
import {
  type VerifyOAuthAccessRequestOptions,
  type VerifyOAuthAccessRequestResult,
  verifyBetterAuthAccessRequest,
} from './oauthAccessToken';

export type VerifyPackageBrokerAccessRequestOptions = Omit<
  VerifyOAuthAccessRequestOptions,
  'audience'
>;

export function verifyPackageBrokerAccessRequest(
  request: Request,
  options: VerifyPackageBrokerAccessRequestOptions
): Promise<VerifyOAuthAccessRequestResult> {
  return verifyBetterAuthAccessRequest(request, {
    ...options,
    audience: PACKAGE_BROKER_AUDIENCE,
  });
}
