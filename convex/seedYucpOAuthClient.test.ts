import { describe, expect, it } from 'bun:test';
import {
  buildUnityOAuthClientMetadata,
  getUnityOAuthClientDescriptors,
} from './seedYucpOAuthClient';

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
});
