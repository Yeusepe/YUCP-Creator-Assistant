import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { VerificationConfig } from './verificationConfig';

type ConvexCall = [unknown, Record<string, unknown>];

const queryMock = mock(async (_ref: unknown, _args: Record<string, unknown>) => ({
  found: true,
  externalAccounts: [],
}));
const mutationMock = mock(async (_ref: unknown, _args: Record<string, unknown>) => true);

mock.module('../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    query: queryMock,
    mutation: mutationMock,
    action: mock(async () => null),
  }),
}));

mock.module('../auth', () => ({
  createAuth: () => ({
    clearVrchatSessionForUser: mock(async () => undefined),
  }),
}));

const { createVerificationRoutes } = await import('./sessionManager');

const testConfig: VerificationConfig = {
  baseUrl: 'http://localhost:3001',
  frontendUrl: 'http://localhost:3000',
  convexUrl: 'test-convex',
  convexApiSecret: 'api-secret',
};

describe('disconnect verification route', () => {
  beforeEach(() => {
    queryMock.mockClear();
    mutationMock.mockClear();
    mutationMock.mockImplementation(async () => true);
    queryMock.mockImplementation(async () => ({
      found: true,
      externalAccounts: [],
    }));
  });

  it('uses buyer account scope for linked-account removal and creator scope for entitlement revocation', async () => {
    const routes = createVerificationRoutes(testConfig);

    const response = await routes.disconnectVerification(
      new Request('https://api.example.com/api/verification/disconnect', {
        method: 'POST',
        body: JSON.stringify({
          apiSecret: 'api-secret',
          authUserId: 'creator_auth_disconnect',
          buyerAccountAuthUserId: 'buyer_auth_disconnect',
          subjectId: 'subject_buyer_disconnect',
          provider: 'gumroad',
        }),
      })
    );

    expect(response.status).toBe(200);

    const mutationCalls = mutationMock.mock.calls as ConvexCall[];
    const queryCalls = queryMock.mock.calls as ConvexCall[];

    expect(mutationCalls).toHaveLength(3);
    expect(mutationCalls[0]?.[1]).toMatchObject({
      authUserId: 'creator_auth_disconnect',
      subjectId: 'subject_buyer_disconnect',
      provider: 'gumroad',
    });
    expect(mutationCalls[1]?.[1]).toMatchObject({
      authUserId: 'buyer_auth_disconnect',
      subjectId: 'subject_buyer_disconnect',
      provider: 'gumroad',
    });
    expect(queryCalls[0]?.[1]).toMatchObject({
      authUserId: 'buyer_auth_disconnect',
      subjectId: 'subject_buyer_disconnect',
    });
    expect(mutationCalls[2]?.[1]).toMatchObject({
      authUserId: 'creator_auth_disconnect',
      subjectId: 'subject_buyer_disconnect',
    });
  });
});
