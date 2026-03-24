import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock, signInSocialMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  signInSocialMock: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({
    options,
  }),
}));

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    getSession: getSessionMock,
    signIn: {
      social: signInSocialMock,
    },
  },
}));

import { Route } from '@/routes/oauth/login';

const CREATOR_LOGIN_QUERY =
  '/oauth/login?response_type=code&client_id=yucp-unity-creator&redirect_uri=https%3A%2F%2Frare-squid-409.convex.site%2Fapi%2Fyucp%2Foauth%2Fcallback&scope=cert%3Aissue%20profile%3Aread&state=test-state&code_challenge=test-challenge&code_challenge_method=S256&exp=1774135005&sig=test';
const USER_LOGIN_QUERY =
  '/oauth/login?response_type=code&client_id=yucp-unity-user&redirect_uri=https%3A%2F%2Frare-squid-409.convex.site%2Fapi%2Fyucp%2Foauth%2Fcallback&scope=verification%3Aread&state=user-state&code_challenge=user-challenge&code_challenge_method=S256&exp=1774135005&sig=test';

describe('oauth login route', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    signInSocialMock.mockReset();
    getSessionMock.mockResolvedValue({
      data: null,
      error: null,
    });
    signInSocialMock.mockResolvedValue(undefined);
    globalThis.fetch = vi.fn();
    window.history.replaceState({}, '', CREATOR_LOGIN_QUERY);
  });

  it('starts social sign-in with the current oauth login page as callbackURL', async () => {
    const Component = Route.options.component;
    if (!Component) {
      throw new Error('OAuth login route component is not defined');
    }

    render(<Component />);

    await waitFor(() => {
      expect(signInSocialMock).toHaveBeenCalledWith({
        provider: 'discord',
        callbackURL: `http://localhost:3000${CREATOR_LOGIN_QUERY}`,
      });
    });
  });

  it('preserves user-domain authorize params when starting social sign-in', async () => {
    window.history.replaceState({}, '', USER_LOGIN_QUERY);

    const Component = Route.options.component;
    if (!Component) {
      throw new Error('OAuth login route component is not defined');
    }

    render(<Component />);

    await waitFor(() => {
      expect(signInSocialMock).toHaveBeenCalledWith({
        provider: 'discord',
        callbackURL: `http://localhost:3000${USER_LOGIN_QUERY}`,
      });
    });
  });

  it('resumes the original authorize request when a session already exists', async () => {
    const assignMock = vi.fn();
    getSessionMock.mockResolvedValue({
      data: {
        session: { id: 'session_123' },
        user: { id: 'user_123' },
      },
      error: null,
    });

    Object.defineProperty(window.location, 'assign', {
      configurable: true,
      value: assignMock,
    });

    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          redirect: true,
          url: 'https://rare-squid-409.convex.site/api/yucp/oauth/callback?code=test-code&state=test-state',
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    );

    const Component = Route.options.component;
    if (!Component) {
      throw new Error('OAuth login route component is not defined');
    }

    render(<Component />);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/auth/oauth2/authorize?response_type=code&client_id=yucp-unity-creator&redirect_uri=https%3A%2F%2Frare-squid-409.convex.site%2Fapi%2Fyucp%2Foauth%2Fcallback&scope=cert%3Aissue+profile%3Aread&state=test-state&code_challenge=test-challenge&code_challenge_method=S256',
        {
          headers: {
            accept: 'application/json',
          },
        }
      );
    });

    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledWith(
        'https://rare-squid-409.convex.site/api/yucp/oauth/callback?code=test-code&state=test-state'
      );
    });

    expect(signInSocialMock).not.toHaveBeenCalled();
  });
});
