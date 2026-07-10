import { beforeEach, describe, expect, it, mock } from 'bun:test';

let queryImpl: (functionReference: unknown, args: unknown) => Promise<unknown>;
let verifyBetterAuthAccessTokenImpl: (token: string, options: unknown) => Promise<unknown>;

const queryMock = mock((functionReference: unknown, args: unknown) =>
  queryImpl(functionReference, args)
);

mock.module('../../../../convex/_generated/api', () => ({
  api: {
    creatorProfiles: {
      getCreatorBySlug: 'creatorProfiles.getCreatorBySlug',
    },
    entitlements: {
      getEntitlementsBySubject: 'entitlements.getEntitlementsBySubject',
      hasActiveEntitlement: 'entitlements.hasActiveEntitlement',
    },
    subjects: {
      getSubjectByAuthId: 'subjects.getSubjectByAuthId',
    },
  },
  components: {},
  internal: {},
}));

mock.module('../lib/convex', () => ({
  getConvexClientFromUrl: () => ({ query: queryMock }),
}));

mock.module('../lib/oauthAccessToken', () => ({
  verifyBetterAuthAccessToken: (token: string, options: unknown) =>
    verifyBetterAuthAccessTokenImpl(token, options),
}));

const { getVerificationStatus } = await import('./suite');

const config = {
  convexUrl: 'https://convex.example.test',
  convexApiSecret: 'test-convex-secret',
  convexSiteUrl: 'https://convex.example.test',
};

beforeEach(() => {
  queryMock.mockClear();
  verifyBetterAuthAccessTokenImpl = async () => ({
    ok: true,
    token: { sub: 'auth-user-1', grantedScopes: ['verification:read'] },
  });
  queryImpl = async (functionReference) => {
    if (functionReference === 'subjects.getSubjectByAuthId') {
      return { found: true, subject: { _id: 'subject-1', status: 'active' } };
    }
    if (functionReference === 'entitlements.getEntitlementsBySubject') {
      return [];
    }
    throw new Error(`Unexpected Convex query: ${String(functionReference)}`);
  };
});

describe('Creator Suite verification status', () => {
  it('returns verified:false when the OAuth-JWT subject has no active entitlements', async () => {
    const response = await getVerificationStatus(
      new Request('https://api.example.test/api/suite/verification/status?authUserId=auth-user-1', {
        headers: { authorization: 'Bearer oauth-jwt' },
      }),
      config
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      verified: false,
      subjectId: 'subject-1',
      products: [],
    });
  });

  it('returns no products when a suspended OAuth-JWT subject has an active entitlement', async () => {
    queryImpl = async (functionReference) => {
      if (functionReference === 'subjects.getSubjectByAuthId') {
        return { found: true, subject: { _id: 'subject-1', status: 'suspended' } };
      }
      if (functionReference === 'entitlements.getEntitlementsBySubject') {
        return [{ productId: 'product-1', status: 'active', grantedAt: 1 }];
      }
      throw new Error(`Unexpected Convex query: ${String(functionReference)}`);
    };

    const response = await getVerificationStatus(
      new Request('https://api.example.test/api/suite/verification/status?authUserId=auth-user-1', {
        headers: { authorization: 'Bearer oauth-jwt' },
      }),
      config
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      verified: false,
      subjectId: 'subject-1',
      products: [],
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
