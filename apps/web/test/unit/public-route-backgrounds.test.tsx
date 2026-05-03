import { cleanup, render, screen } from '@testing-library/react';
import type { ComponentType, PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type TestRoute = {
  options: {
    component?: ComponentType;
  };
};

const { useNavigateMock, useSearchMock } = vi.hoisted(() => ({
  useNavigateMock: vi.fn(() => vi.fn()),
  useSearchMock: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    search,
    ...props
  }: PropsWithChildren<{ to: string; search?: Record<string, string> }>) => (
    <a
      href={
        search && Object.keys(search).length > 0
          ? `${to}?${new URLSearchParams(search).toString()}`
          : to
      }
      {...props}
    >
      {children}
    </a>
  ),
  createFileRoute: () => (options: unknown) => ({
    options,
    useSearch: useSearchMock,
  }),
  createLazyFileRoute: () => (options: unknown) => ({
    options,
    useSearch: useSearchMock,
  }),
  useNavigate: useNavigateMock,
}));

vi.mock('canvas-confetti', () => ({
  default: vi.fn(),
}));

vi.mock('@/components/page/BackgroundCanvasRoot', () => ({
  BackgroundCanvasRoot: ({ position }: { position?: 'fixed' | 'absolute' }) => (
    <div data-testid="background-canvas-root" data-position={position ?? 'fixed'} />
  ),
}));

vi.mock('@/components/ui/Select', () => ({
  Select: ({
    id,
    onChange,
    options,
    value,
  }: {
    id?: string;
    value: string;
    options: Array<{ value: string; label: string }>;
    onChange: (value: string) => void;
  }) => (
    <select
      aria-label={id ?? 'select'}
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

import { Route as CollabInviteRoute } from '@/routes/collab-invite';
import { Route as InstallErrorRoute } from '@/routes/install/error.lazy';
import { Route as InstallSuccessRoute } from '@/routes/install/success.lazy';
import { Route as PrivacyPolicyRoute } from '@/routes/legal/privacy-policy';
import { Route as TermsOfServiceRoute } from '@/routes/legal/terms-of-service';
import { Route as OAuthConsentRoute } from '@/routes/oauth/consent.lazy';
import { Route as OAuthErrorRoute } from '@/routes/oauth/error';
import { Route as DiscordRoleSetupRoute } from '@/routes/setup/discord-role';

describe('public route backgrounds', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    useSearchMock.mockReset();
    useNavigateMock.mockReset();
    useNavigateMock.mockReturnValue(vi.fn());

    Object.defineProperty(window, 'fetch', {
      configurable: true,
      writable: true,
      value: vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

        if (url.includes('/api/collab/session/invite')) {
          return new Response(
            JSON.stringify({
              ownerDisplayName: 'Creator',
              providerKey: 'jinxxy',
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        if (url.includes('/api/setup/discord-role-guilds')) {
          return new Response(
            JSON.stringify({
              guilds: [{ id: 'guild-1', name: 'My Server' }],
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        return new Response('{}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    });

    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
    });

    window.history.replaceState({}, '', '/');
  });

  it('mounts the shared cloud background for the collab invite route', async () => {
    useSearchMock.mockReturnValue({
      auth: undefined,
      t: undefined,
    });

    const Component = CollabInviteRoute.options.component;
    if (!Component) {
      throw new Error('Collab invite route component is not defined');
    }

    render(<Component />);

    expect(await screen.findByTestId('background-canvas-root')).toHaveAttribute(
      'data-position',
      'fixed'
    );
  });

  it.each([
    ['privacy policy', PrivacyPolicyRoute as TestRoute],
    ['terms of service', TermsOfServiceRoute as TestRoute],
    ['oauth consent', OAuthConsentRoute as TestRoute],
    ['oauth error', OAuthErrorRoute as TestRoute],
    ['install success', InstallSuccessRoute as TestRoute],
    ['install error', InstallErrorRoute as TestRoute],
    ['discord role setup', DiscordRoleSetupRoute as TestRoute],
  ] as const)('mounts the shared cloud background for %s', (_label, route) => {
    useSearchMock.mockReturnValue({
      error: undefined,
      guild_id: undefined,
    });

    const Component = route.options.component;
    if (!Component) {
      throw new Error('Route component is not defined');
    }

    render(<Component />);

    expect(screen.getByTestId('background-canvas-root')).toHaveAttribute('data-position', 'fixed');
  });
});
