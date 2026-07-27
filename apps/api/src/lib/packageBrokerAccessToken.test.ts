import { expect, mock, test } from 'bun:test';
import { PACKAGE_BROKER_AUDIENCE } from '@yucp/shared';

const verifyBetterAuthAccessRequest = mock(async () => ({
  ok: false as const,
  reason: 'invalid' as const,
}));

mock.module('./oauthAccessToken', () => ({
  verifyBetterAuthAccessRequest,
}));

const { verifyPackageBrokerAccessRequest } = await import('./packageBrokerAccessToken');

test('verifies package operations against the dedicated broker resource', async () => {
  const request = new Request('https://api.example.test/api/v2/package-installs/authorizations');
  const dpopReplayStore = { reserve: async () => true };

  await verifyPackageBrokerAccessRequest(request, {
    convexSiteUrl: 'https://auth.example.test',
    dpopReplayStore,
    requiredAuthorizedParty: 'yucp-package-broker',
    requiredScopes: ['package:operate'],
  });

  expect(verifyBetterAuthAccessRequest).toHaveBeenCalledWith(request, {
    audience: PACKAGE_BROKER_AUDIENCE,
    convexSiteUrl: 'https://auth.example.test',
    dpopReplayStore,
    requiredAuthorizedParty: 'yucp-package-broker',
    requiredScopes: ['package:operate'],
  });
});
