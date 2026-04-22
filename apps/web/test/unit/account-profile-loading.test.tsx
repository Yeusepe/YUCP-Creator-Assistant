import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  createLazyFileRoute: () => (options: unknown) => ({ options }),
  getRouteApi: () => ({
    useLoaderData: () => ({
      guilds: [],
      viewer: {},
    }),
  }),
}));

import { Route as AccountProfileRoute } from '../../src/routes/_authenticated/account/index.lazy';

describe('account profile pending state', () => {
  it('keeps the profile card shell visible while the route chunk is loading', () => {
    const Pending = AccountProfileRoute.options.pendingComponent;
    if (!Pending) {
      throw new Error('Account profile pending component is not defined');
    }

    const { container } = render(<Pending />);

    expect(screen.getByText('Discord identity')).toBeInTheDocument();
    expect(screen.getByText('Your access')).toBeInTheDocument();
    expect(container.querySelectorAll('.account-surface-card').length).toBeGreaterThanOrEqual(3);
    expect(container.querySelector('.skeleton-stack')).toBeNull();
  });
});
