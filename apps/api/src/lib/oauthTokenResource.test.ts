import { describe, expect, it } from 'bun:test';
import { PUBLIC_API_AUDIENCE } from '@yucp/shared';
import { bindPublicApiOAuthResource } from './oauthTokenResource';

describe('bindPublicApiOAuthResource', () => {
  it('binds authorization code exchanges to the public API URI', () => {
    const body = bindPublicApiOAuthResource(
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

  it('replaces a caller resource with the API resource', () => {
    const body = bindPublicApiOAuthResource(
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: 'refresh-token',
        resource: 'https://unrelated.example',
      })
    );

    expect(body.get('resource')).toBe(PUBLIC_API_AUDIENCE);
  });
});
