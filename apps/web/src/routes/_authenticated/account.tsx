import { createFileRoute } from '@tanstack/react-router';
import { PageLoadingOverlay } from '@/components/page/PageLoadingOverlay';
import { dashboardShellQueryOptions } from '@/lib/dashboardQueryOptions';
import { primeDashboardShellCaches } from '@/lib/dashboardShellCache';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';
import { type DashboardShellData, fetchDashboardShell } from '@/lib/server/dashboard';

let accountLoaderCache: DashboardShellData | null = null;

export const Route = createFileRoute('/_authenticated/account')({
  head: () => ({
    links: routeStylesheetLinks(
      routeStyleHrefs.dashboard,
      routeStyleHrefs.dashboardComponents,
      routeStyleHrefs.account
    ),
  }),
  staleTime: Infinity,
  pendingComponent: AccountLayoutPending,
  loader: async ({ context: { queryClient } }) => {
    if (typeof window !== 'undefined' && accountLoaderCache !== null) {
      return accountLoaderCache;
    }
    const shell = await queryClient.ensureQueryData(
      dashboardShellQueryOptions({
        queryKey: ['dashboard-shell'],
        queryFn: () => fetchDashboardShell({ data: { includeHomeData: false } }),
      })
    );
    primeDashboardShellCaches(queryClient, shell);
    if (typeof window !== 'undefined') {
      accountLoaderCache = shell;
    }
    return shell;
  },
});

function AccountLayoutPending() {
  return <PageLoadingOverlay />;
}
