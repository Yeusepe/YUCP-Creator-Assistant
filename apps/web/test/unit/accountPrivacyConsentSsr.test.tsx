import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-query', () => ({
  useMutation: vi.fn(() => ({
    isPending: false,
    mutate: vi.fn(),
  })),
}));

vi.mock('@tanstack/react-router', () => ({
  createLazyFileRoute: () => (options: unknown) => ({ options }),
  useNavigate: vi.fn(() => vi.fn()),
}));

// The page records consent through Convex, which needs a provider this render has
// no reason to mount.
vi.mock('convex/react', () => ({
  useMutation: vi.fn(() => vi.fn(async () => undefined)),
}));

vi.mock('@/api/client', () => ({
  apiClient: {
    delete: vi.fn(),
  },
}));

vi.mock('@/components/ui/Toast', () => ({
  useToast: vi.fn(() => ({
    error: vi.fn(),
    success: vi.fn(),
  })),
}));

import { Route } from '@/routes/_authenticated/account/privacy.lazy';

describe('account privacy SSR consent state', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does not claim no choice has been made before client preferences hydrate', () => {
    const Component = Route.options.component;
    if (!Component) {
      throw new Error('Account privacy route component is not defined');
    }

    const markup = renderToString(<Component />);

    expect(markup).not.toContain('Not chosen yet');
    expect(markup).toContain('Checking saved choice');
  });
});
