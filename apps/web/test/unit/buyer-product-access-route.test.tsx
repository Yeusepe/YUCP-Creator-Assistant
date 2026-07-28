import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useLoaderDataMock = vi.hoisted(() => vi.fn());
const useSearchMock = vi.hoisted(() => vi.fn(() => ({ grant: undefined, intent_id: undefined })));
const copyToClipboardMock = vi.hoisted(() => vi.fn());
const clearProductAccessGrantFromUrlMock = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({
    options,
    useLoaderData: useLoaderDataMock,
    useSearch: useSearchMock,
  }),
  Link: ({ children }: PropsWithChildren) => <a href="/account/licenses">{children}</a>,
}));

vi.mock('@/components/three/CloudBackground', () => ({
  CloudBackground: () => null,
}));

vi.mock('@/lib/server/productAccess', () => ({
  fetchBuyerProductAccess: vi.fn(),
}));

vi.mock('@/lib/productAccess', () => ({
  buildProductAccessReturnPath: () => '/access/catalog%2Fproduct',
  clearProductAccessGrantFromUrl: clearProductAccessGrantFromUrlMock,
  createBuyerProductAccessVerificationIntent: vi.fn(),
}));

vi.mock('@/hooks/usePublicAuth', () => ({
  usePublicAuth: () => ({
    authUserId: 'buyer-user-1',
    isAuthenticated: true,
    isPending: false,
    signIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));

vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }),
}));

vi.mock('@/lib/utils', () => ({
  copyToClipboard: copyToClipboardMock,
}));

import { Route as BuyerProductAccessRoute } from '@/routes/access.$catalogProductId';

const repository = {
  indexUrl:
    'https://vpm.test/api/vpm/access/SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS/index.json',
  addRepoUrl:
    'vcc://vpm/addRepo?url=https%3A%2F%2Fvpm.test%2Fapi%2Fvpm%2Faccess%2FSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS%2Findex.json',
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('buyer product access route', () => {
  beforeEach(() => {
    cleanup();
    useSearchMock.mockReturnValue({ grant: undefined, intent_id: undefined });
    copyToClipboardMock.mockReset();
    clearProductAccessGrantFromUrlMock.mockReset();
  });

  it('clears verification grants from the URL after reading the return state', async () => {
    const Component = BuyerProductAccessRoute.options.component;
    if (!Component) throw new Error('Buyer product access route component is not defined');
    useSearchMock.mockReturnValue({ grant: 'sensitive-grant', intent_id: 'intent-123' });
    useLoaderDataMock.mockReturnValue({
      product: {
        catalogProductId: 'catalog/product',
        displayName: 'Avatar Bundle',
        canonicalSlug: null,
        thumbnailUrl: null,
        provider: 'gumroad',
        providerLabel: 'Gumroad',
        storefrontUrl: null,
        storefronts: [
          {
            catalogProductId: 'catalog/product',
            provider: 'gumroad',
            providerLabel: 'Gumroad',
            storefrontUrl: null,
          },
        ],
      },
      accessState: { hasActiveEntitlement: true, requiresVerification: false },
      repository,
    });

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(clearProductAccessGrantFromUrlMock).toHaveBeenCalledOnce());
  });

  it('exposes no paid artifact URL outside the authenticated importer flow', async () => {
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
        storefronts: [
          {
            catalogProductId: 'catalog/product',
            provider: 'gumroad',
            providerLabel: 'Gumroad',
            storefrontUrl: null,
          },
        ],
      },
      accessState: {
        hasActiveEntitlement: true,
        requiresVerification: false,
      },
      repository,
    });

    render(<Component />, { wrapper: createWrapper() });

    expect(await screen.findByRole('button', { name: 'Add to VCC' })).toBeEnabled();
    expect(screen.queryByRole('link', { name: 'Download' })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="/api/access/"]')).not.toBeInTheDocument();
  });

  it('describes buyer delivery without exposing protection implementation terms', async () => {
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
        storefronts: [
          {
            catalogProductId: 'catalog/product',
            provider: 'gumroad',
            providerLabel: 'Gumroad',
            storefrontUrl: null,
          },
        ],
      },
      accessState: {
        hasActiveEntitlement: true,
        requiresVerification: false,
      },
      repository,
    });

    render(<Component />, { wrapper: createWrapper() });

    expect(
      screen.getByText('Purchase-verified VCC setup and package delivery')
    ).toBeInTheDocument();
    expect(screen.queryByText(/protected downloads/i)).not.toBeInTheDocument();
  });

  it('shows every explicitly linked storefront for one package access page', async () => {
    const Component = BuyerProductAccessRoute.options.component;
    if (!Component) {
      throw new Error('Buyer product access route component is not defined');
    }

    useLoaderDataMock.mockReturnValue({
      product: {
        catalogProductId: 'catalog-jammr-gumroad',
        displayName: 'JAMMR',
        canonicalSlug: 'jammr',
        thumbnailUrl: null,
        provider: 'gumroad',
        providerLabel: 'Gumroad',
        storefrontUrl: 'https://gumroad.test/jammr',
        storefronts: [
          {
            catalogProductId: 'catalog-jammr-gumroad',
            provider: 'gumroad',
            providerLabel: 'Gumroad',
            providerIcon: 'Gumorad.png',
            storefrontUrl: 'https://gumroad.test/jammr',
          },
          {
            catalogProductId: 'catalog-jammr-jinxxy',
            provider: 'jinxxy',
            providerLabel: 'Jinxxy',
            providerIcon: 'Jinxxy.png',
            storefrontUrl: 'https://jinxxy.test/jammr',
          },
        ],
      },
      accessState: {
        hasActiveEntitlement: true,
        requiresVerification: false,
      },
      repository,
    });

    render(<Component />, { wrapper: createWrapper() });

    expect(screen.queryByText('Gumroad + Jinxxy')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Gumroad' })).toHaveAttribute(
      'src',
      '/Icons/Gumorad.png'
    );
    expect(screen.getByRole('img', { name: 'Jinxxy' })).toHaveAttribute('src', '/Icons/Jinxxy.png');
    expect(screen.getByRole('link', { name: 'Gumroad store' })).toHaveAttribute(
      'href',
      'https://gumroad.test/jammr'
    );
    expect(screen.getByRole('link', { name: 'Jinxxy store' })).toHaveAttribute(
      'href',
      'https://jinxxy.test/jammr'
    );
    expect(
      screen.getByRole('link', { name: 'Gumroad store' }).querySelector('img')
    ).toHaveAttribute('src', '/Icons/Gumorad.png');
    expect(screen.getByRole('link', { name: 'Jinxxy store' }).querySelector('img')).toHaveAttribute(
      'src',
      '/Icons/Jinxxy.png'
    );
  });

  it('hides the store link for storefronts without a public product URL', async () => {
    const Component = BuyerProductAccessRoute.options.component;
    if (!Component) {
      throw new Error('Buyer product access route component is not defined');
    }

    useLoaderDataMock.mockReturnValue({
      product: {
        catalogProductId: 'catalog-jammr-gumroad',
        displayName: 'JAMMR',
        canonicalSlug: 'jammr',
        thumbnailUrl: null,
        provider: 'gumroad',
        providerLabel: 'Gumroad',
        storefrontUrl: 'https://gumroad.test/jammr',
        storefronts: [
          {
            catalogProductId: 'catalog-jammr-gumroad',
            provider: 'gumroad',
            providerLabel: 'Gumroad',
            providerIcon: 'Gumorad.png',
            storefrontUrl: 'https://gumroad.test/jammr',
          },
          {
            catalogProductId: 'catalog-jammr-jinxxy',
            provider: 'jinxxy',
            providerLabel: 'Jinxxy',
            providerIcon: 'Jinxxy.png',
            storefrontUrl: null,
          },
        ],
      },
      accessState: {
        hasActiveEntitlement: true,
        requiresVerification: false,
      },
      repository,
    });

    render(<Component />, { wrapper: createWrapper() });

    expect(screen.queryByText('Gumroad + Jinxxy')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Gumroad' })).toHaveAttribute(
      'src',
      '/Icons/Gumorad.png'
    );
    expect(screen.getByRole('img', { name: 'Jinxxy' })).toHaveAttribute('src', '/Icons/Jinxxy.png');
    expect(screen.getByRole('link', { name: 'Gumroad store' })).toHaveAttribute(
      'href',
      'https://gumroad.test/jammr'
    );
    expect(screen.queryByRole('link', { name: 'Jinxxy store' })).not.toBeInTheDocument();
  });

  it('shows the durable creator-managed VPM handoff with a copyable index URL', async () => {
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
        storefronts: [
          {
            catalogProductId: 'catalog/product',
            provider: 'gumroad',
            providerLabel: 'Gumroad',
            storefrontUrl: null,
          },
        ],
      },
      accessState: {
        hasActiveEntitlement: true,
        requiresVerification: false,
      },
      repository,
    });
    copyToClipboardMock.mockResolvedValue(true);

    render(<Component />, { wrapper: createWrapper() });

    const addRepoButton = await screen.findByRole('button', { name: 'Add to VCC' });
    expect(addRepoButton).toBeEnabled();
    expect(screen.getByText(repository.indexUrl)).toBeVisible();
    expect(screen.getByText(repository.addRepoUrl)).toBeVisible();

    const manualSetupToggle = screen.getByRole('button', {
      name: 'Manual setup and troubleshooting',
    });
    const manualSetupPanel = manualSetupToggle.nextElementSibling;
    expect(manualSetupPanel).toHaveAttribute('inert');

    fireEvent.click(manualSetupToggle);
    expect(manualSetupPanel).not.toHaveAttribute('inert');
    expect(manualSetupToggle.querySelector('desc')?.textContent).toContain(
      'Line Arrow Down Large 1'
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[1]);
    await waitFor(() => {
      expect(copyToClipboardMock).toHaveBeenCalledWith(repository.indexUrl);
    });
  });

  it('uses the HeroUI Pro stepper with one numbered or completed indicator per step', async () => {
    const Component = BuyerProductAccessRoute.options.component;
    if (!Component) throw new Error('Buyer product access route component is not defined');
    useLoaderDataMock.mockReturnValue({
      product: {
        catalogProductId: 'catalog/product',
        displayName: 'Avatar Bundle',
        canonicalSlug: null,
        thumbnailUrl: null,
        provider: 'gumroad',
        providerLabel: 'Gumroad',
        storefrontUrl: null,
        storefronts: [
          {
            catalogProductId: 'catalog/product',
            provider: 'gumroad',
            providerLabel: 'Gumroad',
            storefrontUrl: null,
          },
        ],
      },
      accessState: { hasActiveEntitlement: false, requiresVerification: true },
    });

    render(<Component />, { wrapper: createWrapper() });

    const steps = screen.getByRole('list', { name: 'Access steps' });
    const completedStep = screen.getByText('Sign in').closest('[data-slot="stepper-step"]');
    const activeStep = screen.getByText('Verify').closest('[data-slot="stepper-step"]');
    const upcomingStep = screen.getByText('Add to VCC').closest('[data-slot="stepper-step"]');

    expect(steps).toHaveClass('stepper', 'stepper--horizontal');
    expect(completedStep).toHaveAttribute('data-status', 'complete');
    expect(activeStep).toHaveAttribute('data-status', 'active');
    expect(upcomingStep).toHaveAttribute('data-status', 'inactive');
    expect(steps.querySelectorAll('[data-slot="stepper-indicator"]')).toHaveLength(3);
    expect(steps.querySelectorAll('[data-slot="stepper-separator"]')).toHaveLength(2);
    expect(steps.querySelector('.plo-bag-scene')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add to VCC' })).not.toBeInTheDocument();
  });

  it('defines dark-theme counterparts for changed progress colors', () => {
    const styles = readFileSync(resolve(__dirname, '../../src/styles/product-access.css'), 'utf8');

    expect(styles).toContain('.dark .vpa-steps');
    expect(styles).toContain('--stepper-active-color: #70e2ff');
    expect(styles).not.toContain('.vpa-step-dot');
    expect(styles).not.toContain(
      'background: linear-gradient(180deg, rgba(59, 130, 246, 0.95), rgba(37, 99, 235, 0.98))'
    );
  });

  it('defines explicit dark-theme counterparts for manual setup colors', () => {
    const styles = readFileSync(resolve(__dirname, '../../src/styles/product-access.css'), 'utf8');

    for (const selector of [
      '.vpa-manual',
      '.vpa-manual-toggle',
      '.vpa-manual-toggle:hover',
      '.vpa-manual-copy',
      '.vpa-repo-box',
      '.vpa-repo-url',
    ]) {
      expect(styles, `Missing dark counterpart for ${selector}`).toContain(`.dark ${selector}`);
    }
  });
});
