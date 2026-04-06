import { createFileRoute } from '@tanstack/react-router';
import { warmDashboardCollaboration } from '@/lib/dashboardPrefetch';

export const Route = createFileRoute('/_authenticated/dashboard/collaboration')({
  staleTime: Infinity,
  loader: ({ context: { queryClient } }) => {
    warmDashboardCollaboration(queryClient);
    return null;
  },
});
