import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock, postMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  postMock: vi.fn(),
}));

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    getSession: getSessionMock,
  },
}));

vi.mock('@/api/client', () => ({
  apiClient: {
    post: postMock,
  },
}));

import { activateCreatorAccount, CreatorAccountSessionExpiredError } from '@/lib/account';

describe('creator account activation', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    postMock.mockReset();
  });

  it('revalidates the durable Better Auth session before activating the creator account', async () => {
    getSessionMock.mockResolvedValue({
      data: {
        session: { id: 'session-1' },
        user: { id: 'user-1' },
      },
      error: null,
    });
    postMock.mockResolvedValue({
      creatorAccount: { isActive: true },
      created: false,
    });

    await expect(activateCreatorAccount()).resolves.toEqual({
      creatorAccount: { isActive: true },
      created: false,
    });

    expect(getSessionMock).toHaveBeenCalledWith({
      query: {
        disableCookieCache: true,
      },
    });
    expect(postMock).toHaveBeenCalledWith('/api/connect/creator-account');
    expect(getSessionMock.mock.invocationCallOrder[0]).toBeLessThan(
      postMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it('does not call the activation mutation when the durable session has expired', async () => {
    getSessionMock.mockResolvedValue({
      data: null,
      error: {
        message: 'Session expired',
      },
    });

    await expect(activateCreatorAccount()).rejects.toBeInstanceOf(
      CreatorAccountSessionExpiredError
    );
    expect(postMock).not.toHaveBeenCalled();
  });
});
