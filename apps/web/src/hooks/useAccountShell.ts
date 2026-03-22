import { getRouteApi } from '@tanstack/react-router';
import type { DashboardShellData } from '@/lib/server/dashboard';

const accountRouteApi = getRouteApi('/account');

export function useAccountShell() {
  return accountRouteApi.useLoaderData() as DashboardShellData;
}
