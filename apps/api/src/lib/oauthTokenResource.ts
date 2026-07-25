import { PUBLIC_API_AUDIENCE } from '@yucp/shared';

export function bindPublicApiOAuthResource(body: URLSearchParams): URLSearchParams {
  const boundBody = new URLSearchParams(body);
  boundBody.set('resource', PUBLIC_API_AUDIENCE);
  return boundBody;
}
