import { beforeEach, describe, expect, it, mock } from 'bun:test';

const apiMock = {
  subjects: {
    resolveSubjectForPublicApi: 'subjects.resolveSubjectForPublicApi',
  },
  entitlements: {
    getEntitlementsBySubject: 'entitlements.getEntitlementsBySubject',
  },
} as const;

let queryImpl: (fn: unknown, args: unknown) => Promise<unknown>;

const queryMock = mock((fn: unknown, args: unknown) => queryImpl(fn, args));

mock.module('../../../../../convex/_generated/api', () => ({
  api: apiMock,
}));

mock.module('../../lib/convex', () => ({
  getConvexClientFromUrl: () => ({ query: queryMock }),
}));

mock.module('./auth', () => ({
  resolveAuth: async () => ({
    authUserId: 'user_abc',
    actorBinding: {
      payload: 'test-payload',
      signature: 'test-signature',
    },
    scopes: ['verification:read'],
  }),
}));

const { handleVerificationRoutes } = await import('./verification');

const config = {
  apiBaseUrl: 'https://api.test',
  convexUrl: 'https://test.convex.cloud',
  convexApiSecret: 'test-secret',
  convexSiteUrl: 'https://test.convex.site',
  encryptionSecret: 'test-enc',
  frontendBaseUrl: 'https://creators.test',
};

const sampleSubject = {
  _id: 'subject_001',
  authUserId: 'buyer_abc',
  primaryDiscordUserId: 'discord_001',
  status: 'active',
};

const sampleEntitlement = {
  _id: 'ent_001',
  subjectId: sampleSubject._id,
  productId: 'product_001',
  status: 'active',
};

function makeRequest(method: string, subPath: string, body?: unknown): Request {
  const url = `http://localhost/api/public/v2${subPath}`;
  return new Request(url, {
    method,
    headers: {
      authorization: 'Bearer test-token',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  queryMock.mockClear();
  queryImpl = async (fn) => {
    if (fn === apiMock.subjects.resolveSubjectForPublicApi) {
      return { found: true, subject: sampleSubject };
    }
    if (fn === apiMock.entitlements.getEntitlementsBySubject) {
      return [sampleEntitlement];
    }
    throw new Error(`Unhandled query: ${String(fn)}`);
  };
});

describe('handleVerificationRoutes', () => {
  it('GET /verification/status unwraps resolved subject before loading entitlements', async () => {
    const res = await handleVerificationRoutes(
      makeRequest('GET', '/verification/status'),
      '/verification/status',
      config
    );

    expect(res.status).toBe(200);
    expect(
      queryMock.mock.calls.some(
        (call) =>
          call[0] === apiMock.entitlements.getEntitlementsBySubject &&
          (call[1] as Record<string, unknown>).subjectId === sampleSubject._id
      )
    ).toBe(true);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.subject).toEqual(sampleSubject);
    expect(body.entitlements).toEqual([sampleEntitlement]);
  });

  it('POST /verification/check returns negative results when the wrapper is not found', async () => {
    queryImpl = async (fn) => {
      if (fn === apiMock.subjects.resolveSubjectForPublicApi) {
        return { found: false, subject: null };
      }
      if (fn === apiMock.entitlements.getEntitlementsBySubject) {
        throw new Error('entitlements should not be loaded when subject is missing');
      }
      throw new Error(`Unhandled query: ${String(fn)}`);
    };

    const res = await handleVerificationRoutes(
      makeRequest('POST', '/verification/check', {
        subject: { subjectId: sampleSubject._id },
        productIds: ['product_001', 'product_002'],
      }),
      '/verification/check',
      config
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.subject).toBeNull();
    expect(body.results).toEqual([
      { productId: 'product_001', entitled: false, entitlement: null },
      { productId: 'product_002', entitled: false, entitlement: null },
    ]);
  });
});
