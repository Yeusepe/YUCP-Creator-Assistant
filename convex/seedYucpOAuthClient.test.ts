import { describe, expect, it } from 'bun:test';
import {
  buildUnityOAuthClientMetadata,
  getUnityOAuthClientDescriptors,
} from './seedYucpOAuthClient';
import { OAUTH_PROVIDER_SCOPES } from './betterAuth/oauthProviderScopes';

describe('buildUnityOAuthClientMetadata', () => {
  it('serializes Unity OAuth client metadata as a JSON string for Better Auth storage', () => {
    const metadata = buildUnityOAuthClientMetadata({
      clientId: 'yucp-unity-user',
      name: 'YUCP Unity User',
      scopes: ['verification:read'],
      authDomain: 'user',
    });

    expect(typeof metadata).toBe('string');
    expect(JSON.parse(metadata)).toEqual({
      firstParty: true,
      platform: 'unity',
      authDomain: 'user',
    });
  });
});

describe('getUnityOAuthClientDescriptors', () => {
  it('allows the Unity importer to request product delivery scope', () => {
    const userClient = getUnityOAuthClientDescriptors().find(
      (client) => client.clientId === 'yucp-unity-user'
    );

    expect(userClient?.scopes).toContain('verification:read');
    expect(userClient?.scopes).toContain('products:read');
  });

  it('allows the Unity creator tools to read product catalog entries', () => {
    const creatorClient = getUnityOAuthClientDescriptors().find(
      (client) => client.clientId === 'yucp-unity-creator'
    );

    expect(creatorClient?.scopes).toContain('cert:issue');
    expect(creatorClient?.scopes).toContain('profile:read');
    expect(creatorClient?.scopes).toContain('products:read');
  });

  it('keeps every Unity client scope registered with the Better Auth provider', () => {
    const providerScopes = new Set<string>(OAUTH_PROVIDER_SCOPES);

    for (const descriptor of getUnityOAuthClientDescriptors()) {
      for (const scope of descriptor.scopes) {
        expect(providerScopes.has(scope)).toBe(true);
      }
    }
  });
});
