import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({
    options,
  }),
  redirect: vi.fn(),
}));

vi.mock('@/components/page/BackgroundCanvasRoot', () => ({
  BackgroundCanvasRoot: () => null,
}));

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    signIn: {
      social: vi.fn(),
    },
    oauth2: {
      consent: vi.fn(),
    },
  },
}));

describe('oauth route contract', () => {
  it('does not install SSR auth redirects on oauth login and consent pages', async () => {
    const { Route: loginRoute } = await import('@/routes/oauth/login');
    const { Route: consentRoute } = await import('@/routes/oauth/consent');

    expect(loginRoute.options.beforeLoad).toBeUndefined();
    expect(consentRoute.options.beforeLoad).toBeUndefined();
  });
});
