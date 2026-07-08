import { beforeEach, describe, expect, it, mock } from 'bun:test';

const apiMock = {
  subjects: {
    resolveSubjectForPublicApi: 'subjects.resolveSubjectForPublicApi',
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
    scopes: ['subjects:read'],
  }),
}));

const { handleSubjectsRoutes } = await import('./subjects');

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

function makeRequest(method: string, subPath: string): Request {
  const url = `http://localhost/api/public/v2${subPath}`;
  return new Request(url, {
    method,
    headers: {
      authorization: 'Bearer test-token',
    },
  });
}

beforeEach(() => {
  queryMock.mockClear();
  queryImpl = async (fn) => {
    if (fn === apiMock.subjects.resolveSubjectForPublicApi) {
      return { found: true, subject: sampleSubject };
    }
    throw new Error(`Unhandled query: ${String(fn)}`);
  };
});

describe('handleSubjectsRoutes', () => {
  it('GET /subjects/:id unwraps resolved subjects before returning them', async () => {
    const res = await handleSubjectsRoutes(
      makeRequest('GET', '/subjects/subject_001'),
      '/subjects/subject_001',
      config
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sampleSubject);
  });

  it('GET /subjects/:id returns 404 when the resolved wrapper is not found', async () => {
    queryImpl = async (fn) => {
      if (fn === apiMock.subjects.resolveSubjectForPublicApi) {
        return { found: false, subject: null };
      }
      throw new Error(`Unhandled query: ${String(fn)}`);
    };

    const res = await handleSubjectsRoutes(
      makeRequest('GET', '/subjects/missing_subject'),
      '/subjects/missing_subject',
      config
    );

    expect(res.status).toBe(404);
  });
});
