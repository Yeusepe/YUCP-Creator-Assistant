import { describe, expect, it } from 'bun:test';
import { PACKAGE_BROKER_AUDIENCE } from '@yucp/shared';
import { OAUTH_PROVIDER_SCOPES } from './betterAuth/oauthProviderScopes';
import {
  buildPackageBrokerOAuthClientMetadata,
  buildPackageBrokerOAuthClientRecord,
  buildPackageBrokerOAuthClientResourceLink,
  buildPackageBrokerOAuthResourceRecord,
  getPackageBrokerOAuthClientDescriptors,
  getSupersededPackageOAuthClientIds,
} from './seedYucpOAuthClient';

describe('buildPackageBrokerOAuthClientMetadata', () => {
  it('assigns credential ownership to the native package broker', () => {
    const metadata = buildPackageBrokerOAuthClientMetadata({
      clientId: 'yucp-package-broker',
      name: 'YUCP Package Broker',
      scopes: ['package:operate'],
      authDomain: 'user',
    });

    expect(typeof metadata).toBe('string');
    expect(JSON.parse(metadata)).toEqual({
      firstParty: true,
      credentialOwner: 'native-package-broker',
      platform: 'native',
      authDomain: 'user',
    });
  });
});

describe('getPackageBrokerOAuthClientDescriptors', () => {
  it('defines one least-privilege package broker and retires Unity credential owners', () => {
    expect(getPackageBrokerOAuthClientDescriptors()).toHaveLength(1);
    expect(getPackageBrokerOAuthClientDescriptors()[0]).toMatchObject({
      clientId: 'yucp-package-broker',
      scopes: ['package:operate', 'offline_access'],
    });
    expect(getSupersededPackageOAuthClientIds()).toEqual(['yucp-unity-user', 'yucp-unity-creator']);
  });

  it('keeps every package broker scope registered with the Better Auth provider', () => {
    const providerScopes = new Set<string>(OAUTH_PROVIDER_SCOPES);

    for (const descriptor of getPackageBrokerOAuthClientDescriptors()) {
      for (const scope of descriptor.scopes) {
        expect(providerScopes.has(scope)).toBe(true);
      }
    }
  });

  it('requires DPoP-bound access tokens for each native public client', () => {
    for (const descriptor of getPackageBrokerOAuthClientDescriptors()) {
      expect(
        buildPackageBrokerOAuthClientRecord(descriptor, 'http://127.0.0.1/callback')
      ).toMatchObject({
        dpopBoundAccessTokens: true,
        public: true,
        tokenEndpointAuthMethod: 'none',
      });
    }
  });
});

describe('package broker OAuth protected resource records', () => {
  it('uses the shared RFC 8707 resource and complete scope policy', () => {
    expect(buildPackageBrokerOAuthResourceRecord()).toEqual({
      identifier: PACKAGE_BROKER_AUDIENCE,
      name: 'YUCP package operations',
      allowedScopes: ['package:operate', 'offline_access'],
      accessTokenTtl: 300,
      refreshTokenTtl: 2_592_000,
      dpopBoundAccessTokensRequired: true,
      disabled: false,
      policyVersion: 1,
    });
  });

  it('links every package broker client to the dedicated package resource', () => {
    for (const descriptor of getPackageBrokerOAuthClientDescriptors()) {
      expect(buildPackageBrokerOAuthClientResourceLink(descriptor)).toEqual({
        clientId: descriptor.clientId,
        resourceId: PACKAGE_BROKER_AUDIENCE,
      });
    }
  });
});
