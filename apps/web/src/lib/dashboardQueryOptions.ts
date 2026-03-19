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

export function dashboardQueryOptions<
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
