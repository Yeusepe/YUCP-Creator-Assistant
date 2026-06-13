import { getPinnedYucpJwkSet } from '@yucp/shared/yucpTrust';

export function buildYucpKeysResponse(): Response {
  return Response.json(
    {
      keys: getPinnedYucpJwkSet(),
    },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    }
  );
}
