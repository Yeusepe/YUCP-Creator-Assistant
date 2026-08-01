import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  createLazyFileRoute: () => (options: unknown) => ({ options }),
}));

vi.mock('canvas-confetti', () => ({
  default: vi.fn(),
}));

vi.mock('@/components/page/BackgroundCanvasRoot', () => ({
  BackgroundCanvasRoot: ({ position }: { position?: 'fixed' | 'absolute' }) => (
    <div data-testid="setup-background" data-position={position ?? 'fixed'} />
  ),
}));

import { Route as JinxxySetupRoute } from '@/routes/setup/jinxxy.lazy';
import { Route as LemonSqueezySetupRoute } from '@/routes/setup/lemonsqueezy.lazy';
import { Route as PayhipSetupRoute } from '@/routes/setup/payhip.lazy';

type TestRoute = {
  options: {
    component?: ComponentType;
  };
};

const SETUP_ROUTES = [
  ['Jinxxy', JinxxySetupRoute as TestRoute, /connect jinxxy/i],
  ['Lemon Squeezy', LemonSqueezySetupRoute as TestRoute, /connect lemon.squeezy/i],
  ['Payhip', PayhipSetupRoute as TestRoute, /connect payhip/i],
] as const;

function getComponent(route: TestRoute) {
  const Component = route.options.component;
  if (!Component) {
    throw new Error('Setup route component is not defined');
  }
  return Component;
}

function getStepLabel(label: string) {
  return screen.getByText(
    (_content, element) =>
      element?.tagName === 'SPAN' && element.textContent?.replace(/\s+/g, ' ').trim() === label
  );
}

describe('setup shell behavior', () => {
  beforeAll(() => {
    class TestResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: TestResizeObserver,
    });
  });

  beforeEach(() => {
    window.history.replaceState({}, '', '/setup');
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      writable: true,
      value: vi.fn().mockResolvedValue(
        new Response('{}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      ),
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it.each(
    SETUP_ROUTES
  )('shows the %s setup content on its first render', (_name, route, heading) => {
    const Component = getComponent(route);
    render(<Component />);

    expect(screen.getByRole('heading', { name: heading })).toBeVisible();
  });

  it.each(
    SETUP_ROUTES
  )('places the %s cloud canvas inside the setup shell', (_name, route, heading) => {
    const Component = getComponent(route);
    const { container } = render(<Component />);

    const background = screen.getByTestId('setup-background');
    expect(background).toHaveAttribute('data-position', 'absolute');
    expect(container).toContainElement(background);
    expect(screen.getByRole('heading', { name: heading })).toBeVisible();
  });

  it('starts Jinxxy at the first of seven actionable setup steps', () => {
    const Component = getComponent(JinxxySetupRoute as TestRoute);
    render(<Component />);

    expect(getStepLabel('Step 1 of 7')).toBeVisible();
    expect(screen.getByRole('button', { name: /back/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /next step/i })).toBeEnabled();
  });

  it('advances Lemon Squeezy to the API key connection step', () => {
    const Component = getComponent(LemonSqueezySetupRoute as TestRoute);
    render(<Component />);

    expect(getStepLabel('Step 1 of 2')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));

    expect(getStepLabel('Step 2 of 2')).toBeVisible();
    expect(screen.getByRole('button', { name: /connect lemon squeezy/i })).toBeDisabled();
  });

  it('keeps Payhip on the API key step and explains the missing value', async () => {
    const Component = getComponent(PayhipSetupRoute as TestRoute);
    render(<Component />);

    expect(getStepLabel('Step 1 / 4')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /next step/i }));

    expect(await screen.findByText('Enter your Payhip API key.')).toBeVisible();
    expect(getStepLabel('Step 1 / 4')).toBeVisible();
  });

  it('preserves tenant and server context in every setup dashboard link', () => {
    window.history.replaceState({}, '', '/setup?tenant_id=tenant-123&guild_id=guild-123');

    for (const [, route] of SETUP_ROUTES) {
      const Component = getComponent(route);
      render(<Component />);

      const dashboardLink = screen.getByRole('link', { name: /dashboard/i });
      expect(dashboardLink).toHaveAttribute(
        'href',
        expect.stringContaining('tenant_id=tenant-123')
      );
      expect(dashboardLink).toHaveAttribute('href', expect.stringContaining('guild_id=guild-123'));
      cleanup();
    }
  });
});
