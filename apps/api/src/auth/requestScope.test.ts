import { beforeEach, describe, expect, it, mock } from 'bun:test';

const apiMock = {
  authViewer: {
    getViewer: 'authViewer.getViewer',
  },
} as const;

const setAuthMock = mock((_token: string) => undefined);
const queryMock = mock(async () => null);

mock.module('../../../../convex/_generated/api', () => ({
  api: apiMock,
}));

mock.module('convex/browser', () => ({
  ConvexHttpClient: class {
    setAuth(token: string) {
      setAuthMock(token);
    }

    query(functionReference: unknown, args?: unknown) {
      return queryMock(functionReference, args);
    }
  },
}));

const { createAuth } = await import('./index');

describe('request-scoped auth caching', () => {
  beforeEach(() => {
    setAuthMock.mockClear();
    queryMock.mockClear();
    queryMock.mockResolvedValue({
      authUserId: 'auth-user-123',
      email: 'creator@example.com',
      name: 'Creator',
      image: null,
      discordUserId: 'discord-user-123',
    });
  });

  it('coalesces viewer resolution when session and discord identity are read on one request', async () => {
    const auth = createAuth({
      baseUrl: 'http://localhost:3001',
      convexSiteUrl: 'http://localhost:3210',
      convexUrl: 'http://localhost:3210',
    });

    const request = new Request('http://localhost:3001/connect', {
      headers: {
        'x-auth-token': 'viewer-token',
      },
    });

    const [session, discordUserId] = await Promise.all([
      auth.getSession(request),
      auth.getDiscordUserId(request),
    ]);

    expect(session).toEqual({
      user: {
        id: 'auth-user-123',
        email: 'creator@example.com',
        name: 'Creator',
        image: null,
      },
      discordUserId: 'discord-user-123',
    });
    expect(discordUserId).toBe('discord-user-123');
    expect(setAuthMock).toHaveBeenCalledTimes(1);
    expect(setAuthMock).toHaveBeenCalledWith('viewer-token');
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledWith(apiMock.authViewer.getViewer, {});
  });
});
