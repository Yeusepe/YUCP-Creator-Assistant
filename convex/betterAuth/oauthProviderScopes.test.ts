import { describe, expect, it } from 'bun:test';
import { PUBLIC_API_SCOPES } from '@yucp/shared';
import {
  OAUTH_NATIVE_REFRESH_TOKEN_REUSE_INTERVAL_SECONDS,
  PACKAGE_BROKER_OPERATION_SCOPE,
  OAUTH_PROVIDER_SCOPES,
  OAUTH_REFRESH_TOKEN_SCOPE,
} from './oauthProviderScopes';

describe('OAUTH_PROVIDER_SCOPES', () => {
  it('registers public API scopes plus refresh-token access with Better Auth', () => {
    expect(OAUTH_PROVIDER_SCOPES).toEqual([
      ...PUBLIC_API_SCOPES,
      PACKAGE_BROKER_OPERATION_SCOPE,
      OAUTH_REFRESH_TOKEN_SCOPE,
    ]);
    expect(OAUTH_PROVIDER_SCOPES).toContain('offline_access');
    expect(OAUTH_NATIVE_REFRESH_TOKEN_REUSE_INTERVAL_SECONDS).toBe(30);
  });
});
