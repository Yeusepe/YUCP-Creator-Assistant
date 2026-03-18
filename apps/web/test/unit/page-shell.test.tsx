import { render } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Route as SignInRoute } from '@/routes/sign-in';

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
    const SignInPage = SignInRoute.options.component;
    const { container } = render(<SignInPage />);

    expect(container.querySelector('#page-loading-overlay .plo-bag-scene')).toBeTruthy();

    vi.runAllTimers();

    expect(container.querySelector('#page-content')?.classList.contains('visible')).toBe(true);
    expect((container.querySelector('#page-loading-overlay') as HTMLDivElement | null)?.style.display)
      .toBe('none');
  });
});
