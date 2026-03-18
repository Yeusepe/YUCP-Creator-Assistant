import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCurrentSignInUrl } from '@/lib/authUrls';
import { SignInPage } from '@/routes/sign-in';

vi.mock('@/components/three/CloudBackground', () => ({
  CloudBackground: () => <div data-testid="cloud-background" />,
}));

describe('Page shell boot', () => {
  let originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame | undefined;
  let originalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame | undefined;
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
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

  it('renders the original loading overlay scene and dismisses it after reveal', async () => {
    const { container } = render(<SignInPage signInUrl="/api/auth/sign-in/discord" />);

    expect(container.querySelector('#page-loading-overlay .plo-bag-scene')).toBeTruthy();

    await vi.runAllTimersAsync();

    expect(container.querySelector('#page-content')?.classList.contains('visible')).toBe(true);
    expect(
      (container.querySelector('#page-loading-overlay') as HTMLDivElement | null)?.style.display
    ).toBe('none');
  });

  it('keeps dashboard auth independent from guild selection in the Discord callback URL', () => {
    const signInUrl = buildCurrentSignInUrl(
      'http://localhost:3000/sign-in?redirectTo=%2Fdashboard%3Fguild_id%3D123'
    );
    const { container } = render(<SignInPage signInUrl={signInUrl} />);
    const href = (container.querySelector('#discord-signin-btn') as HTMLAnchorElement | null)?.href;

    expect(href).toBeTruthy();
    if (!href) {
      throw new Error('Expected the Discord sign-in button to render an href.');
    }

    const discordUrl = new URL(href);
    expect(discordUrl.pathname).toBe('/api/auth/sign-in/discord/start');
    expect(discordUrl.searchParams.get('callbackURL')).toBeNull();
    expect(discordUrl.searchParams.get('returnTo')).toBe('/sign-in?redirectTo=%2Fdashboard');
  });
});
