import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { signInSocialMock } = vi.hoisted(() => ({
  signInSocialMock: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({
    options,
  }),
}));

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    signIn: {
      social: signInSocialMock,
    },
  },
}));

import { Route } from '@/routes/oauth/login';

describe('oauth login route', () => {
  beforeEach(() => {
    signInSocialMock.mockReset();
    signInSocialMock.mockResolvedValue(undefined);
    window.history.replaceState(
      {},
      '',
      '/oauth/login?response_type=code&client_id=yucp-unity-editor&scope=cert%3Aissue&sig=test'
    );
  });

  it('starts social sign-in without sending oauth login back to itself as callbackURL', async () => {
    const Component = Route.options.component;
    if (!Component) {
      throw new Error('OAuth login route component is not defined');
    }

    render(<Component />);

    await waitFor(() => {
      expect(signInSocialMock).toHaveBeenCalledWith({
        provider: 'discord',
      });
    });
  });
});
