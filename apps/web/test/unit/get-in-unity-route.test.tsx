import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockUseParams = vi.fn();
const mockUseSearch = vi.fn();
const signInMock = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({
    options,
    useParams: () => mockUseParams(),
    useSearch: () => mockUseSearch(),
  }),
}));

vi.mock('@/components/three/CloudBackground', () => ({
  CloudBackground: ({ variant }: { variant?: 'default' | '404' }) => (
    <div data-testid="cloud-background" data-variant={variant ?? 'default'} />
  ),
}));

vi.mock('@/hooks/usePublicAuth', () => ({
  usePublicAuth: vi.fn(),
}));

vi.mock('@/lib/backstageAccess', () => ({
  createBuyerBackstageVerificationIntent: vi.fn(),
  getBuyerBackstageAccessInfo: vi.fn(),
  requestUserBackstageRepoAccess: vi.fn(),
}));

import { usePublicAuth } from '@/hooks/usePublicAuth';
import * as backstageAccessApi from '@/lib/backstageAccess';
import { Route as GetInUnityRoute } from '@/routes/get-in-unity.$creatorRef.$productRef';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('get in unity route', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    mockUseParams.mockReturnValue({
      creatorRef: 'mapache',
      productRef: 'song-thing',
    });
    mockUseSearch.mockReturnValue({
      grant: undefined,
      intent_id: undefined,
    });

    vi.mocked(usePublicAuth).mockReturnValue({
      isAuthenticated: false,
      isPending: false,
      signIn: signInMock,
      signOut: vi.fn(),
    });

    vi.mocked(backstageAccessApi.getBuyerBackstageAccessInfo).mockResolvedValue({
      creatorName: 'Mapache',
      creatorRepoRef: 'mapache',
      productRef: 'song-thing',
      title: 'Song Thing',
      provider: 'gumroad',
      primaryPackageId: 'com.yucp.song',
      packageSummaries: [
        {
          packageId: 'com.yucp.song',
          displayName: 'Song Thing Package',
          latestPublishedVersion: '1.2.3',
        },
      ],
      ready: true,
    });
  });

  it('shows a sign-in CTA for buyers before verification starts', async () => {
    const Component = GetInUnityRoute.options.component;
    if (!Component) {
      throw new Error('Get in Unity route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    expect(await screen.findByText('Song Thing')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /sign in to continue/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /sign in to continue/i }));

    await waitFor(() => expect(signInMock).toHaveBeenCalled());
  });

  it('shows Add to VCC after the buyer returns with a verification grant', async () => {
    mockUseSearch.mockReturnValue({
      grant: 'grant-token',
      intent_id: 'intent_1',
    });
    vi.mocked(usePublicAuth).mockReturnValue({
      isAuthenticated: true,
      isPending: false,
      signIn: signInMock,
      signOut: vi.fn(),
    });
    vi.mocked(backstageAccessApi.requestUserBackstageRepoAccess).mockResolvedValue({
      creatorName: 'Mapache',
      creatorRepoRef: 'mapache',
      repositoryUrl: 'https://api.test/v1/backstage/repos/mapache/index.json',
      repositoryName: 'Mapache repo',
      addRepoUrl:
        'vcc://vpm/addRepo?url=https%3A%2F%2Fapi.test%2Fv1%2Fbackstage%2Frepos%2Fmapache%2Findex.json',
      expiresAt: Date.now() + 60_000,
    });

    const Component = GetInUnityRoute.options.component;
    if (!Component) {
      throw new Error('Get in Unity route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    expect(await screen.findByRole('button', { name: /add to vcc/i })).toBeInTheDocument();
    expect(await screen.findByText(/manual setup and troubleshooting/i)).toBeInTheDocument();
  });
});
