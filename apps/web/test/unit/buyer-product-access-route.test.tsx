import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const useLoaderDataMock = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({ options, useLoaderData: useLoaderDataMock }),
}));

vi.mock('@/components/three/CloudBackground', () => ({
  CloudBackground: () => null,
}));

vi.mock('@/lib/server/productAccess', () => ({
  fetchBuyerProductAccess: vi.fn(),
}));

import { Route as BuyerProductAccessRoute } from '@/routes/access.$catalogProductId';

describe('buyer product access route', () => {
  it('offers the local signed-download endpoint to entitled buyers', () => {
    const Component = BuyerProductAccessRoute.options.component;
    if (!Component) {
      throw new Error('Buyer product access route component is not defined');
    }

    useLoaderDataMock.mockReturnValue({
      product: {
        catalogProductId: 'catalog/product',
        displayName: 'Avatar Bundle',
        canonicalSlug: null,
        thumbnailUrl: null,
        provider: 'gumroad',
        providerLabel: 'Gumroad',
        storefrontUrl: null,
      },
      accessState: {
        hasActiveEntitlement: true,
        requiresVerification: false,
      },
    });

    render(<Component />);

    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      '/api/access/catalog%2Fproduct/download'
    );
  });
});
