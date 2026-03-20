import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  DASHBOARD_QUERY_STALE_TIME,
  dashboardPollingQueryOptions,
  dashboardQueryOptions,
} from '@/lib/dashboardQueryOptions';

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('dashboard query options', () => {
  it('does not refetch fresh cached dashboard data on mount', async () => {
    const queryClient = new QueryClient();
    const queryFn = vi.fn().mockResolvedValue('fresh-viewer');

    queryClient.setQueryData(['dashboard-viewer'], 'cached-viewer');

    const { result } = renderHook(
      () =>
        useQuery(
          dashboardQueryOptions({
            queryKey: ['dashboard-viewer'],
            queryFn,
          })
        ),
      { wrapper: createWrapper(queryClient) }
    );

    await waitFor(() => expect(result.current.data).toBe('cached-viewer'));
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(queryFn).not.toHaveBeenCalled();
  });

  it('does not retry failing dashboard queries by default', async () => {
    const queryClient = new QueryClient();
    const queryFn = vi.fn().mockRejectedValue(new Error('boom'));

    const { result } = renderHook(
      () =>
        useQuery(
          dashboardQueryOptions({
            queryKey: ['dashboard-settings', 'guild-1'],
            queryFn,
          })
        ),
      { wrapper: createWrapper(queryClient) }
    );

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('keeps collaboration polling deliberate and bounded', () => {
    const queryFn = vi.fn();

    const options = dashboardPollingQueryOptions({
      queryKey: ['dashboard-collab-invites', 'user-1'],
      queryFn,
      refetchInterval: 15000,
    });

    expect(options.staleTime).toBe(DASHBOARD_QUERY_STALE_TIME);
    expect(options.retry).toBe(false);
    expect(options.refetchOnWindowFocus).toBe(false);
    expect(options.refetchOnReconnect).toBe(false);
    expect(options.refetchInterval).toBe(15000);
    expect(options.refetchIntervalInBackground).toBe(false);
  });
});
