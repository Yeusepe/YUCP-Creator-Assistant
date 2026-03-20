import { readFileSync } from 'node:fs';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const canvasSpy = vi.hoisted(() =>
  vi.fn(
    ({
      children,
      onCreated,
    }: {
      children?: React.ReactNode;
      gl?: { alpha?: boolean };
      onCreated?: ({ gl }: { gl: { setClearColor: ReturnType<typeof vi.fn> } }) => void;
    }) => {
      onCreated?.({ gl: { setClearColor: vi.fn() } });
      return <div data-testid="background-canvas">{children}</div>;
    }
  )
);

vi.mock('@react-three/fiber', () => ({
  Canvas: (props: { children?: React.ReactNode; gl?: { alpha?: boolean } }) => canvasSpy(props),
}));

vi.mock('@react-three/drei', () => ({
  Clouds: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Sky: () => <div data-testid="background-sky" />,
}));

vi.mock('@/assets/cloud.png', () => ({
  default: '/cloud.png',
}));

vi.mock('@/components/three/MovingCloud', () => ({
  MovingCloud: () => <div data-testid="moving-cloud" />,
}));

import BackgroundApp from '@/components/three/BackgroundApp';
import { CloudBackgroundLayer } from '@/components/three/CloudBackground';

describe('Cloud background loading', () => {
  let originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame | undefined;
  let originalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    canvasSpy.mockClear();
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

  it('keeps a static sky surface mounted while the deferred canvas is still warming up', async () => {
    const { container } = render(<CloudBackgroundLayer />);

    expect(container.querySelector('.cloud-background-surface')).toBeTruthy();
    expect(container.querySelector('.cloud-layer-fade')).toBeNull();
    expect(container.querySelector('.cloud-background-surface')).toBeTruthy();
  });

  it('renders the background scene on a transparent canvas', () => {
    render(<BackgroundApp />);

    expect(canvasSpy).toHaveBeenCalled();
    expect(canvasSpy.mock.calls[0]?.[0]?.gl).toMatchObject({ alpha: true });
  });

  it('uses the requested solid fallback colors for light and dark mode', () => {
    const globalsCss = readFileSync('src/styles/globals.css', 'utf8');

    expect(globalsCss).toContain('.cloud-background-surface');
    expect(globalsCss).toContain('background: #7da4c9;');
    expect(globalsCss).toContain('.dark .cloud-background-surface');
    expect(globalsCss).toContain('background: #658db6;');
  });

  it('does not report the background as ready until the next animation frame', async () => {
    const onReady = vi.fn();

    render(<BackgroundApp onReady={onReady} />);

    expect(onReady).not.toHaveBeenCalled();

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(onReady).toHaveBeenCalledTimes(1);
  });
});
