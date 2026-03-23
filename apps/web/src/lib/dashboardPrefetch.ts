import type { QueryClient } from '@tanstack/react-query';
import { listCreatorCertificates } from '@/lib/certificates';
import {
  listCollabConnections,
  listCollabConnectionsAsCollaborator,
  listCollabInvites,
  listCollabProviders,
  listOAuthApps,
  listPublicApiKeys,
} from '@/lib/dashboard';
import { dashboardLoaderQueryOptions } from '@/lib/dashboardQueryOptions';
import type { DashboardShellData } from '@/lib/server/dashboard';

const DASHBOARD_SHELL_QUERY_KEY = ['dashboard-shell'] as const;

function getDashboardShell(queryClient: QueryClient): DashboardShellData | undefined {
  return queryClient.getQueryData<DashboardShellData>(DASHBOARD_SHELL_QUERY_KEY);
}

export function warmDashboardIntegrations(queryClient: QueryClient): void {
  const authUserId = getDashboardShell(queryClient)?.viewer.authUserId;
  if (!authUserId) {
    return;
  }

  void queryClient.prefetchQuery(
    dashboardLoaderQueryOptions({
      queryKey: ['dashboard-oauth-apps', authUserId],
      queryFn: () => listOAuthApps(authUserId),
    })
  );
  void queryClient.prefetchQuery(
    dashboardLoaderQueryOptions({
      queryKey: ['dashboard-api-keys', authUserId],
      queryFn: () => listPublicApiKeys(authUserId),
    })
  );
}

export function warmDashboardCollaboration(queryClient: QueryClient): void {
  const authUserId = getDashboardShell(queryClient)?.viewer.authUserId;
  if (!authUserId) {
    return;
  }

  void queryClient.prefetchQuery(
    dashboardLoaderQueryOptions({
      queryKey: ['dashboard-collab-providers'],
      queryFn: listCollabProviders,
    })
  );
  void queryClient.prefetchQuery(
    dashboardLoaderQueryOptions({
      queryKey: ['dashboard-collab-invites', authUserId],
      queryFn: () => listCollabInvites(authUserId),
    })
  );
  void queryClient.prefetchQuery(
    dashboardLoaderQueryOptions({
      queryKey: ['dashboard-collab-connections', authUserId],
      queryFn: () => listCollabConnections(authUserId),
    })
  );
  void queryClient.prefetchQuery(
    dashboardLoaderQueryOptions({
      queryKey: ['dashboard-collab-as-collaborator', authUserId],
      queryFn: () => listCollabConnectionsAsCollaborator(authUserId),
    })
  );
}

export function warmDashboardCertificates(queryClient: QueryClient): void {
  void queryClient.prefetchQuery(
    dashboardLoaderQueryOptions({
      queryKey: ['creator-certificates'],
      queryFn: listCreatorCertificates,
    })
  );
}
