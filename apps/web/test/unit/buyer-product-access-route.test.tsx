import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useLoaderDataMock = vi.hoisted(() => vi.fn());
const mintBuyerVpmRepositoryMock = vi.hoisted(() => vi.fn());
const copyToClipboardMock = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({ options, useLoaderData: useLoaderDataMock }),
}));

vi.mock('@/components/three/CloudBackground', () => ({
  CloudBackground: () => null,
}));

vi.mock('@/lib/server/productAccess', () => ({
  fetchBuyerProductAccess: vi.fn(),
}));

vi.mock('@/lib/productAccess', () => ({
  mintBuyerVpmRepository: mintBuyerVpmRepositoryMock,
}));

vi.mock('@/lib/utils', () => ({
  copyToClipboard: copyToClipboardMock,
}));

import { Route as BuyerProductAccessRoute } from '@/routes/access.$catalogProductId';

describe('buyer product access route', () => {
  beforeEach(() => {
    cleanup();
    mintBuyerVpmRepositoryMock.mockReset();
    copyToClipboardMock.mockReset();
  });

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

  it('mints and shows the buyer VPM handoff with a copyable index URL', async () => {
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
    let resolveMint:
      | ((value: { token: string; indexUrl: string; addRepoUrl: string }) => void)
      | undefined;
    mintBuyerVpmRepositoryMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMint = resolve;
        })
    );
    const repository = {
      token: 'buyer-token',
      indexUrl: 'https://vpm.test/api/vpm/buyer-token/index.json',
      addRepoUrl:
        'vcc://vpm/addRepo?url=https%3A%2F%2Fvpm.test%2Fapi%2Fvpm%2Fbuyer-token%2Findex.json',
    };
    copyToClipboardMock.mockResolvedValue(true);

    render(<Component />);
    fireEvent.click(screen.getByRole('button', { name: 'Get VPM repo' }));

    expect(screen.getByRole('button', { name: 'Preparing VPM repo...' })).toBeDisabled();
    resolveMint?.(repository);
    const addRepoLink = await screen.findByRole('link', { name: 'Add to VCC' });
    expect(addRepoLink).toHaveAttribute(
      'href',
      'vcc://vpm/addRepo?url=https%3A%2F%2Fvpm.test%2Fapi%2Fvpm%2Fbuyer-token%2Findex.json'
    );
    expect(screen.getByText('https://vpm.test/api/vpm/buyer-token/index.json')).toBeVisible();
    expect(
      screen.getByText(
        'vcc://vpm/addRepo?url=https%3A%2F%2Fvpm.test%2Fapi%2Fvpm%2Fbuyer-token%2Findex.json'
      )
    ).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Copy index URL' }));
    await waitFor(() => {
      expect(copyToClipboardMock).toHaveBeenCalledWith(
        'https://vpm.test/api/vpm/buyer-token/index.json'
      );
    });
  });
});
