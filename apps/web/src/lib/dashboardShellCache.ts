import type { QueryClient } from '@tanstack/react-query';
import { VIEWER_BRANDING_QUERY_KEY } from '@/lib/brandingAssets';
import type { DashboardShellData } from '@/lib/server/dashboard';

const DASHBOARD_SHELL_QUERY_KEY = ['dashboard-shell'] as const;

export function primeDashboardShellCaches(
  queryClient: QueryClient,
  shell: DashboardShellData
): void {
  const baseShell: DashboardShellData = {
    viewer: shell.viewer,
    branding: shell.branding,
    guilds: shell.guilds,
    ...(shell.home ? { home: shell.home } : {}),
  };

  queryClient.setQueryData(DASHBOARD_SHELL_QUERY_KEY, baseShell);
  queryClient.setQueryData(VIEWER_BRANDING_QUERY_KEY, shell.branding);

  if (!shell.home) {
    return;
  }

  queryClient.setQueryData(['dashboard-providers'], shell.home.providers);
  queryClient.setQueryData(['dashboard-user-accounts'], shell.home.userAccounts);
  queryClient.setQueryData(
    ['dashboard-connection-status', shell.home.connectionStatusAuthUserId],
    shell.home.connectionStatusByProvider
  );

  if (shell.selectedServer) {
    queryClient.setQueryData(
      ['dashboard-settings', shell.selectedServer.authUserId],
      shell.selectedServer.policy
    );
  }
}
