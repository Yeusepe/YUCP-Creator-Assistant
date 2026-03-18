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

  beforeEach(() => {
    vi.useFakeTimers();
    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    window.history.replaceState({}, '', 'http://localhost:3000/sign-in');
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0)) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((handle: number) =>
      clearTimeout(handle)) as typeof globalThis.cancelAnimationFrame;
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
  });

  it('renders the original loading overlay scene and dismisses it after reveal', () => {
    const { container } = render(<SignInPage signInUrl="/api/auth/sign-in/discord" />);

    expect(container.querySelector('#page-loading-overlay .plo-bag-scene')).toBeTruthy();

    vi.runAllTimers();

    expect(container.querySelector('#page-content')?.classList.contains('visible')).toBe(true);
    expect(
      (container.querySelector('#page-loading-overlay') as HTMLDivElement | null)?.style.display
    ).toBe('none');
  });

  it('preserves redirectTo in the Discord sign-in callback URL', () => {
    const signInUrl = buildCurrentSignInUrl(
      'http://localhost:3000/sign-in?redirectTo=%2Fdashboard%3Fguild_id%3D123',
      'http://localhost:3001'
    );
    const { container } = render(<SignInPage signInUrl={signInUrl} />);
    const href = (container.querySelector('#discord-signin-btn') as HTMLAnchorElement | null)?.href;

    expect(href).toBeTruthy();
    if (!href) {
      throw new Error('Expected the Discord sign-in button to render an href.');
    }

    const discordUrl = new URL(href);
    expect(discordUrl.pathname).toBe('/api/auth/sign-in/discord');
    expect(discordUrl.searchParams.get('callbackURL')).toBe(
      'http://localhost:3001/sign-in?redirectTo=%2Fdashboard%3Fguild_id%3D123'
    );
  });
});
