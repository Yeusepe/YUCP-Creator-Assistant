import { describe, expect, it } from 'bun:test';
import { PACKAGE_BROKER_AUDIENCE, PUBLIC_API_AUDIENCE, PUBLIC_API_SCOPES } from '@yucp/shared';
import { OAUTH_PROVIDER_SCOPES } from './betterAuth/oauthProviderScopes';
import {
  buildPackageBrokerOAuthClientMetadata,
  buildPackageBrokerOAuthClientRecord,
  buildPackageBrokerOAuthClientResourceLink,
  buildPackageBrokerOAuthResourceRecord,
  buildPackageBrokerOAuthResourceRecords,
  buildPublicApiOAuthResourceRecord,
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
      resource: PACKAGE_BROKER_AUDIENCE,
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
  it('defines one least-privilege client per native app and retires Unity credential owners', () => {
    expect(getPackageBrokerOAuthClientDescriptors()).toHaveLength(2);
    expect(getPackageBrokerOAuthClientDescriptors()[0]).toMatchObject({
      clientId: 'yucp-package-broker',
      scopes: ['package:operate', 'offline_access'],
      resource: PACKAGE_BROKER_AUDIENCE,
    });
    expect(getPackageBrokerOAuthClientDescriptors()[1]).toMatchObject({
      clientId: 'yucp-package-exporter',
      scopes: ['cert:issue', 'products:read', 'verification:read', 'offline_access'],
      resource: PUBLIC_API_AUDIENCE,
    });
    expect(getSupersededPackageOAuthClientIds()).toEqual(['yucp-unity-user', 'yucp-unity-creator']);
  });

  it('never lets one native client hold both package and certificate authority', () => {
    for (const descriptor of getPackageBrokerOAuthClientDescriptors()) {
      const scopes = new Set<string>(descriptor.scopes);
      expect(scopes.has('package:operate') && scopes.has('cert:issue')).toBe(false);
    }
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

  it('registers the public API resource apps/api injects by default', () => {
    expect(buildPublicApiOAuthResourceRecord()).toEqual({
      identifier: PUBLIC_API_AUDIENCE,
      name: 'YUCP public API',
      allowedScopes: [...PUBLIC_API_SCOPES, 'offline_access'],
      accessTokenTtl: 3600,
      refreshTokenTtl: 2_592_000,
      dpopBoundAccessTokensRequired: false,
      disabled: false,
      policyVersion: 1,
    });
    expect(buildPublicApiOAuthResourceRecord().allowedScopes).toContain('cert:issue');
  });

  it('seeds every resource a first-party client is linked to', () => {
    const identifiers = new Set(
      buildPackageBrokerOAuthResourceRecords().map((record) => record.identifier)
    );

    for (const descriptor of getPackageBrokerOAuthClientDescriptors()) {
      expect(identifiers.has(descriptor.resource)).toBe(true);
    }
  });

  it('links every native client to its own dedicated resource', () => {
    for (const descriptor of getPackageBrokerOAuthClientDescriptors()) {
      expect(buildPackageBrokerOAuthClientResourceLink(descriptor)).toEqual({
        clientId: descriptor.clientId,
        resourceId: descriptor.resource,
      });
    }
  });

  it('keeps every client scope inside its resource scope policy', () => {
    const allowedByResource = new Map(
      buildPackageBrokerOAuthResourceRecords().map((record) => [
        record.identifier,
        new Set<string>(record.allowedScopes),
      ])
    );

    for (const descriptor of getPackageBrokerOAuthClientDescriptors()) {
      const allowed = allowedByResource.get(descriptor.resource);
      for (const scope of descriptor.scopes) {
        expect(allowed?.has(scope)).toBe(true);
      }
    }
  });
});
