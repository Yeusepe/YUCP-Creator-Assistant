import type { QueryKey, UseQueryOptions } from '@tanstack/react-query';

export const DASHBOARD_QUERY_STALE_TIME = 60_000;

type DashboardQueryInput<
  TQueryFnData,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
> = Omit<
  UseQueryOptions<TQueryFnData, Error, TData, TQueryKey>,
  'staleTime' | 'retry' | 'refetchOnWindowFocus' | 'refetchOnReconnect'
>;

type DashboardPollingQueryInput<
  TQueryFnData,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
> = DashboardQueryInput<TQueryFnData, TData, TQueryKey> & {
  refetchInterval: number;
};

export function dashboardPanelQueryOptions<
  TQueryFnData,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(options: DashboardQueryInput<TQueryFnData, TData, TQueryKey>) {
  return {
    ...options,
    staleTime: DASHBOARD_QUERY_STALE_TIME,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  } satisfies UseQueryOptions<TQueryFnData, Error, TData, TQueryKey>;
}

export function dashboardQueryOptions<
  TQueryFnData,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(options: DashboardQueryInput<TQueryFnData, TData, TQueryKey>) {
  return dashboardPanelQueryOptions(options);
}

/**
 * Query options for use inside route loaders.
 *
 * Uses staleTime: Infinity so ensureQueryData only fetches when the cache is
 * completely empty (first visit). Once data is in cache the loader never blocks
 * navigation again. The component-level useQuery with dashboardQueryOptions
 * (staleTime: 60s) triggers background refetches using a browser-direct queryFn
 * (1 hop, session cookie) rather than a server function (2 hops via RPC).
 *
 * This split is intentional: server functions call getToken() which works in
 * TanStack Router loader context but is unreliable in React Query background
 * refetch context. Browser-direct fns always work from the component because
 * they use the session cookie automatically.
 */
export function dashboardShellQueryOptions<
  TQueryFnData,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(options: DashboardQueryInput<TQueryFnData, TData, TQueryKey>) {
  return {
    ...options,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  } satisfies UseQueryOptions<TQueryFnData, Error, TData, TQueryKey>;
}

export function dashboardLoaderQueryOptions<
  TQueryFnData,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(options: DashboardQueryInput<TQueryFnData, TData, TQueryKey>) {
  return dashboardShellQueryOptions(options);
}

/**
 * Like dashboardQueryOptions but with staleTime:0 and refetchOnWindowFocus:true.
 * Use for data that should always be fresh when the user returns to the tab.
 */
export function dashboardClientRevalidateQueryOptions<
  TQueryFnData,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(options: DashboardQueryInput<TQueryFnData, TData, TQueryKey>) {
  return {
    ...options,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  } satisfies UseQueryOptions<TQueryFnData, Error, TData, TQueryKey>;
}

export function dashboardFreshQueryOptions<
  TQueryFnData,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(options: DashboardQueryInput<TQueryFnData, TData, TQueryKey>) {
  return dashboardClientRevalidateQueryOptions(options);
}

export function dashboardPollingQueryOptions<
  TQueryFnData,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(options: DashboardPollingQueryInput<TQueryFnData, TData, TQueryKey>) {
  return {
    ...dashboardQueryOptions(options),
    refetchInterval: options.refetchInterval,
    refetchIntervalInBackground: false,
  } satisfies UseQueryOptions<TQueryFnData, Error, TData, TQueryKey>;
}
