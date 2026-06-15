import { describe, expect, it } from 'bun:test';
import { PUBLIC_API_SCOPES } from '@yucp/shared';
import { OAUTH_PROVIDER_SCOPES, OAUTH_REFRESH_TOKEN_SCOPE } from './oauthProviderScopes';

describe('OAUTH_PROVIDER_SCOPES', () => {
  it('registers public API scopes plus refresh-token access with Better Auth', () => {
    expect(OAUTH_PROVIDER_SCOPES).toEqual([...PUBLIC_API_SCOPES, OAUTH_REFRESH_TOKEN_SCOPE]);
    expect(OAUTH_PROVIDER_SCOPES).toContain('offline_access');
  });
});
