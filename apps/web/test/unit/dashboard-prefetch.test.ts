import type { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  warmDashboardCertificates,
  warmDashboardCollaboration,
  warmDashboardIntegrations,
} from '../../src/lib/dashboardPrefetch';

function createQueryClient(authUserId?: string): {
  queryClient: QueryClient;
  getQueryData: ReturnType<typeof vi.fn>;
  prefetchQuery: ReturnType<typeof vi.fn>;
} {
  const getQueryData = vi.fn(() =>
    authUserId
      ? {
          viewer: {
            authUserId,
          },
          guilds: [],
        }
      : undefined
  );
  const prefetchQuery = vi.fn(() => Promise.resolve());

  return {
    queryClient: {
      getQueryData,
      prefetchQuery,
    } as unknown as QueryClient,
    getQueryData,
    prefetchQuery,
  };
}

describe('dashboard warmers', () => {
  it('warms integrations in the background without requiring loader awaits', () => {
    const { queryClient, prefetchQuery, getQueryData } = createQueryClient('auth-user-1');

    warmDashboardIntegrations(queryClient);

    expect(getQueryData).toHaveBeenCalledWith(['dashboard-shell']);
    expect(prefetchQuery).toHaveBeenCalledTimes(2);
    expect(prefetchQuery).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        queryKey: ['dashboard-oauth-apps', 'auth-user-1'],
      })
    );
    expect(prefetchQuery).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        queryKey: ['dashboard-api-keys', 'auth-user-1'],
      })
    );
  });

  it('warms collaboration in the background using the cached shell auth user', () => {
    const { queryClient, prefetchQuery } = createQueryClient('auth-user-2');

    warmDashboardCollaboration(queryClient);

    expect(prefetchQuery).toHaveBeenCalledTimes(4);
    expect(prefetchQuery).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        queryKey: ['dashboard-collab-providers'],
      })
    );
    expect(prefetchQuery).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        queryKey: ['dashboard-collab-invites', 'auth-user-2'],
      })
    );
    expect(prefetchQuery).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        queryKey: ['dashboard-collab-connections', 'auth-user-2'],
      })
    );
    expect(prefetchQuery).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        queryKey: ['dashboard-collab-as-collaborator', 'auth-user-2'],
      })
    );
  });

  it('skips auth-user scoped warmers when the dashboard shell is not cached yet', () => {
    const { queryClient, prefetchQuery } = createQueryClient();

    warmDashboardIntegrations(queryClient);
    warmDashboardCollaboration(queryClient);

    expect(prefetchQuery).not.toHaveBeenCalled();
  });

  it('warms certificates without blocking on shell state', () => {
    const { queryClient, prefetchQuery } = createQueryClient();

    warmDashboardCertificates(queryClient);

    expect(prefetchQuery).toHaveBeenCalledTimes(1);
    expect(prefetchQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ['creator-certificates'],
      })
    );
  });
});
