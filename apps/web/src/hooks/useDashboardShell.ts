import { getRouteApi } from '@tanstack/react-router';
import { useMemo } from 'react';
import type { DashboardShellData } from '@/lib/server/dashboard';

const dashboardRouteApi = getRouteApi('/dashboard');

export function useDashboardShellData() {
  return dashboardRouteApi.useLoaderData() as DashboardShellData;
}

export function useDashboardShell() {
  const { guild_id, tenant_id } = dashboardRouteApi.useSearch();
  const shellData = useDashboardShellData();

  const selectedGuild = useMemo(
    () =>
      shellData.guilds.find(
        (guild) => guild.id === guild_id && (!tenant_id || guild.tenantId === tenant_id)
      ) ?? shellData.guilds.find((guild) => guild.id === guild_id),
    [guild_id, shellData.guilds, tenant_id]
  );

  return {
    ...shellData,
    selectedGuild,
  };
}
