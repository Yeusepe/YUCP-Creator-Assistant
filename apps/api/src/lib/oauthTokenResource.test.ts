import { describe, expect, it } from 'bun:test';
import { PACKAGE_BROKER_AUDIENCE, PUBLIC_API_AUDIENCE } from '@yucp/shared';
import { bindDefaultOAuthResource } from './oauthTokenResource';

describe('bindDefaultOAuthResource', () => {
  it('binds authorization code exchanges to the public API URI', () => {
    const body = bindDefaultOAuthResource(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'authorization-code',
        redirect_uri: 'http://127.0.0.1:49152/callback',
      })
    );

    expect(body.get('resource')).toBe(PUBLIC_API_AUDIENCE);
    const resource = body.get('resource');
    if (!resource) {
      throw new Error('Bound resource is missing');
    }
    expect(new URL(resource).protocol).toBe('https:');
  });

  it('preserves the package broker resource requested by its registered client', () => {
    const body = bindDefaultOAuthResource(
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: 'refresh-token',
        resource: PACKAGE_BROKER_AUDIENCE,
      })
    );

    expect(body.get('resource')).toBe(PACKAGE_BROKER_AUDIENCE);
  });
});
