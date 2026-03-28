import { afterEach, describe, expect, it, mock } from 'bun:test';

const ingestCalls: Array<Record<string, unknown>> = [];
const originalPolarAccessToken = process.env.POLAR_ACCESS_TOKEN;

mock.module('@polar-sh/sdk', () => ({
  Polar: class PolarMock {
    events = {
      ingest: async (args: Record<string, unknown>) => {
        ingestCalls.push(args);
      },
    };
  },
}));

const { ingestUsageEvent } = await import('./certificateBillingSync');

afterEach(() => {
  ingestCalls.length = 0;
  process.env.POLAR_ACCESS_TOKEN = originalPolarAccessToken;
});

describe('certificateBillingSync ingestUsageEvent', () => {
  it('uses a unique external id for each signature.recorded event', async () => {
    process.env.POLAR_ACCESS_TOKEN = 'test-polar-access-token';

    await ingestUsageEvent._handler(
      {} as never,
      {
        authUserId: 'auth-user-1',
        workspaceKey: 'creator-profile:profile-1',
        certNonce: 'cert-123',
      }
    );
    await ingestUsageEvent._handler(
      {} as never,
      {
        authUserId: 'auth-user-1',
        workspaceKey: 'creator-profile:profile-1',
        certNonce: 'cert-123',
      }
    );

    expect(ingestCalls).toHaveLength(2);

    const firstExternalId = (ingestCalls[0].events as Array<{ externalId: string }>)[0]?.externalId;
    const secondExternalId = (ingestCalls[1].events as Array<{ externalId: string }>)[0]
      ?.externalId;

    expect(firstExternalId).toContain('signature.recorded:cert-123');
    expect(secondExternalId).toContain('signature.recorded:cert-123');
    expect(firstExternalId).not.toBe('signature.recorded:cert-123');
    expect(secondExternalId).not.toBe(firstExternalId);
  });
});
