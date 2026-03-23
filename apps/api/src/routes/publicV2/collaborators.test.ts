import { beforeEach, describe, expect, it, mock } from 'bun:test';

let queryImpl: (...args: unknown[]) => Promise<unknown> = async () => [];

mock.module('../../../../../convex/_generated/api', () => ({
  api: {
    collaboratorInvites: {
      listConnectionsByOwner: 'collaboratorInvites.listConnectionsByOwner',
      getConnectionById: 'collaboratorInvites.getConnectionById',
    },
  },
}));

mock.module('../../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    query: (...args: unknown[]) => queryImpl(...args),
    mutation: async () => null,
  }),
}));

mock.module('./auth', () => ({
  resolveAuth: async () => ({
    authUserId: 'user_abc',
    scopes: ['collaborators:read'],
  }),
}));

const { handleCollaboratorsRoutes } = await import('./collaborators');

const config = {
  convexUrl: 'https://test.convex.cloud',
  convexApiSecret: 'test-secret',
  convexSiteUrl: 'https://test.convex.site',
  encryptionSecret: 'test-encryption-secret',
};

beforeEach(() => {
  queryImpl = async () => [];
});

describe('handleCollaboratorsRoutes', () => {
  it('passes pagination params through to the Convex read model', async () => {
    const observedCalls: unknown[][] = [];
    queryImpl = async (...args: unknown[]) => {
      observedCalls.push(args);
      return {
        data: [
          {
            _id: 'conn_123',
            provider: 'jinxxy',
            status: 'active',
            collaboratorDisplayName: 'Collab A',
            createdAt: 123,
            updatedAt: 456,
          },
        ],
        hasMore: true,
        cursor: 'conn_123',
        nextCursor: 'conn_123',
      };
    };

    const response = await handleCollaboratorsRoutes(
      new Request(
        'http://localhost/api/public/v2/collaborators?provider=jinxxy&status=active&limit=10&starting_after=conn_001',
        {
          headers: { authorization: 'Bearer test-token' },
        }
      ),
      '/collaborators',
      config
    );

    expect(observedCalls[0]?.[0]).toBe('collaboratorInvites.listConnectionsByOwner');
    expect(observedCalls[0]?.[1]).toEqual({
      apiSecret: 'test-secret',
      authUserId: 'user_abc',
      provider: 'jinxxy',
      status: 'active',
      cursor: 'conn_001',
      limit: 10,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      object: 'list',
      data: [
        {
          _id: 'conn_123',
          provider: 'jinxxy',
          status: 'active',
          collaboratorDisplayName: 'Collab A',
          createdAt: 123,
          updatedAt: 456,
        },
      ],
      hasMore: true,
      nextCursor: 'conn_123',
    });
  });

  it('returns 404 when the requested collaborator is missing', async () => {
    queryImpl = async () => null;

    const response = await handleCollaboratorsRoutes(
      new Request('http://localhost/api/public/v2/collaborators/conn_missing', {
        headers: { authorization: 'Bearer test-token' },
      }),
      '/collaborators/conn_missing',
      config
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: 'not_found',
    });
  });
});
