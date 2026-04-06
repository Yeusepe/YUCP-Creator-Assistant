import { describe, expect, it, mock } from 'bun:test';
import type { ConvexServerClient } from '../lib/convex';

mock.module('../../../../convex/_generated/api', () => ({
  api: {
    subjects: {
      resolveSubjectForPublicApi: 'subjects.resolveSubjectForPublicApi',
    },
    entitlements: {
      getEntitlementsBySubject: 'entitlements.getEntitlementsBySubject',
    },
  },
  internal: {},
  components: {},
}));

const { createPublicRoutes } = await import('./public');

describe('createPublicRoutes timing', () => {
  const VALID_API_KEY = `ypsk_${'a'.repeat(48)}`;
  const config = {
    convexUrl: 'https://test.convex.cloud',
    convexApiSecret: 'test-secret',
    convexSiteUrl: 'https://test.convex.site',
  };

  it('emits Server-Timing headers for verification status requests', async () => {
    const queryResults = [
      {
        found: true,
        subject: {
          _id: 'subject_123',
          primaryDiscordUserId: 'discord_123',
          status: 'active',
        },
      },
      [
        {
          grantedAt: 123,
          productId: 'prod_123',
          sourceProvider: 'gumroad',
          status: 'active',
        },
      ],
    ];
    const routes = createPublicRoutes(config, {
      createConvexClient: () =>
        ({
          query: async () => queryResults.shift() ?? null,
          mutation: async () => null,
          action: async () => null,
        }) as unknown as ConvexServerClient,
      verifyApiKey: async () => ({
        id: 'key_123',
        userId: 'creator_123',
        enabled: true,
        metadata: { kind: 'public-api', authUserId: 'creator_123' },
        permissions: { publicApi: ['verification:read'] },
      }),
    });

    const response = await routes.handleRequest(
      new Request('http://localhost/api/public/verification/status', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': VALID_API_KEY,
        },
        body: JSON.stringify({
          authUserId: 'creator_123',
          subject: { subjectId: 'subject_123' },
        }),
      }),
      '/api/public/verification/status'
    );

    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);
    expect(response?.headers.get('Server-Timing')).toMatch(
      /auth_api_key;dur=.*convex_subject;dur=.*convex_entitlements;dur=.*serialize;dur=.*total;dur=/
    );
  });
});
