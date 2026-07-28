import { createFileRoute } from '@tanstack/react-router';
import { PageLoadingOverlay } from '@/components/page/PageLoadingOverlay';
import { dashboardQueryOptions } from '@/lib/dashboardQueryOptions';
import { primeDashboardShellCaches } from '@/lib/dashboardShellCache';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';
import { fetchDashboardShell } from '@/lib/server/dashboard';

export const Route = createFileRoute('/_authenticated/account')({
  head: () => ({
    links: routeStylesheetLinks(
      routeStyleHrefs.dashboard,
      routeStyleHrefs.dashboardComponents,
      routeStyleHrefs.account
    ),
  }),
  staleTime: 0,
  pendingComponent: AccountLayoutPending,
  loader: async ({ context: { queryClient } }) => {
    const shell = await queryClient.fetchQuery(
      dashboardQueryOptions({
        queryKey: ['dashboard-shell', 'account'],
        queryFn: () => fetchDashboardShell({ data: { includeHomeData: false } }),
      })
    );
    primeDashboardShellCaches(queryClient, shell);
    return shell;
  },
});

function AccountLayoutPending() {
  return <PageLoadingOverlay />;
}
