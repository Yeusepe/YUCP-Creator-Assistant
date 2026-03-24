import { readFileSync } from 'node:fs';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const frameCallbacks = vi.hoisted(() => [] as Array<() => void>);
const preloadAllSpy = vi.hoisted(() => vi.fn());
const preloadTextureSpy = vi.hoisted(() => vi.fn());
const useTextureMock = vi.hoisted(() =>
  Object.assign(
    vi.fn(() => null),
    {
      preload: preloadTextureSpy,
    }
  )
);

vi.mock('@react-three/fiber', () => ({
  Canvas: (props: { children?: React.ReactNode; gl?: { alpha?: boolean } }) => canvasSpy(props),
  useFrame: (callback: (state: unknown, delta: number) => void) => {
    frameCallbacks.push(() => callback({}, 0));
  },
}));

vi.mock('@react-three/drei', () => ({
  Clouds: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Preload: ({ all }: { all?: boolean }) => {
    preloadAllSpy(all);
    return null;
  },
  Sky: () => <div data-testid="background-sky" />,
  useTexture: useTextureMock,
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
  beforeEach(() => {
    canvasSpy.mockClear();
    preloadAllSpy.mockClear();
    frameCallbacks.length = 0;
  });

  it('keeps a static sky surface mounted while the background scene is still hidden', () => {
    const { container } = render(<CloudBackgroundLayer />);

    expect(container.querySelector('.cloud-background-surface')).toBeTruthy();
    expect(
      container.querySelector('.cloud-background-surface')?.classList.contains('is-hidden')
    ).toBe(false);
    expect(container.querySelector('.cloud-scene-layer')?.classList.contains('is-ready')).toBe(
      false
    );
  });

  it('reveals the live cloud scene after the first rendered frame', async () => {
    const { container } = render(<CloudBackgroundLayer />);

    await act(async () => {
      for (const callback of frameCallbacks.splice(0)) {
        callback();
      }
    });

    expect(
      container.querySelector('.cloud-background-surface')?.classList.contains('is-hidden')
    ).toBe(true);
    expect(container.querySelector('.cloud-scene-layer')?.classList.contains('is-ready')).toBe(
      true
    );
  });

  it('renders the background scene on a transparent canvas and preloads visible assets', () => {
    render(<BackgroundApp />);

    expect(canvasSpy).toHaveBeenCalled();
    expect(canvasSpy.mock.calls[0]?.[0]?.gl).toMatchObject({ alpha: true });
    expect(preloadAllSpy).toHaveBeenCalledWith(true);
    expect(preloadTextureSpy).toHaveBeenCalledWith('/cloud.png');
  });

  it('uses the shared sky fallback surface instead of fading the live scene in', () => {
    const globalsCss = readFileSync('src/styles/globals.css', 'utf8');

    expect(globalsCss).toContain('.cloud-background-surface');
    expect(globalsCss).toContain('background: var(--cloud-fallback-sky);');
    expect(globalsCss).toContain('.dark .cloud-background-surface');
    expect(globalsCss).toContain('.cloud-background-surface.is-hidden');
    expect(globalsCss).toContain('.cloud-scene-layer.is-ready');
    expect(globalsCss).not.toContain('.cloud-layer-fade');
  });

  it('does not report the background as ready until a rendered frame occurs', async () => {
    const onReady = vi.fn();

    render(<BackgroundApp onReady={onReady} />);

    expect(onReady).not.toHaveBeenCalled();

    await act(async () => {
      for (const callback of frameCallbacks.splice(0)) {
        callback();
      }
    });

    expect(onReady).toHaveBeenCalledTimes(1);
  });
});
