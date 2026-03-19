import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authClient } from '@/lib/auth-client';
import { SignInPage } from '@/routes/sign-in';

vi.mock('@/components/three/CloudBackground', () => ({
  CloudBackground: () => <div data-testid="cloud-background" />,
}));

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    signIn: {
      social: vi.fn(),
    },
  },
}));

describe('Page shell boot', () => {
  let originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame | undefined;
  let originalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame | undefined;
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    originalFetch = globalThis.fetch;
    window.history.replaceState({}, '', 'http://localhost:3000/sign-in');
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0)) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((handle: number) =>
      clearTimeout(handle)) as typeof globalThis.cancelAnimationFrame;
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 401 })) as typeof fetch;
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    if (originalRequestAnimationFrame) {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    } else {
      delete (globalThis as Record<string, unknown>).requestAnimationFrame;
    }
    if (originalCancelAnimationFrame) {
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    } else {
      delete (globalThis as Record<string, unknown>).cancelAnimationFrame;
    }
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      delete (globalThis as Record<string, unknown>).fetch;
    }
  });

  it('renders the loading overlay scene and dismisses it after reveal', async () => {
    const { container } = render(<SignInPage />);

    expect(container.querySelector('#page-loading-overlay .plo-bag-scene')).toBeTruthy();

    await vi.runAllTimersAsync();

    expect(container.querySelector('#page-content')?.classList.contains('visible')).toBe(true);
    expect(
      (container.querySelector('#page-loading-overlay') as HTMLDivElement | null)?.style.display
    ).toBe('none');
  });

  it('keeps dashboard auth independent from guild selection in the Discord callback URL', async () => {
    const { container } = render(<SignInPage redirectTo="/dashboard?guild_id=123" />);
    const signInButton = container.querySelector('#discord-signin-btn');

    expect(signInButton).toBeTruthy();
    if (!(signInButton instanceof HTMLButtonElement)) {
      throw new Error('Expected the Discord sign-in button to render as a button.');
    }

    signInButton.click();

    expect(authClient.signIn.social).toHaveBeenCalledWith({
      provider: 'discord',
      callbackURL: '/dashboard',
    });
  });
});
