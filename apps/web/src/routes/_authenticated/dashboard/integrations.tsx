import { createFileRoute } from '@tanstack/react-router';
import { warmDashboardIntegrations } from '@/lib/dashboardPrefetch';

export const Route = createFileRoute('/_authenticated/dashboard/integrations')({
  staleTime: Infinity,
  loader: ({ context: { queryClient } }) => {
    warmDashboardIntegrations(queryClient);
    return null;
  },
});
