import { createFileRoute } from '@tanstack/react-router';

interface DashboardPackagesSearch {
  view?: 'registry' | 'forensics';
}

export const Route = createFileRoute('/_authenticated/dashboard/packages')({
  validateSearch: (search: Record<string, unknown>): DashboardPackagesSearch => ({
    view: search.view === 'forensics' ? 'forensics' : undefined,
  }),
});
