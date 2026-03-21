import { useQuery as useConvexQuery } from 'convex/react';
import { StatCard } from '@/components/dashboard/cards/StatCard';
import { api } from '../../../../../../convex/_generated/api';

export interface ServerHealthPanelProps {
  linkedProvidersCount: number;
}

function UsersIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function StoreIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function ActivityIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}

export function ServerHealthPanel({ linkedProvidersCount }: ServerHealthPanelProps) {
  const stats = useConvexQuery(api.dashboardViews.getMyDashboardStats);
  const loading = stats === undefined;

  return (
    <section aria-label="Server Health" className="col-span-full">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Verified Members"
          value={stats?.totalVerified ?? 0}
          icon={<UsersIcon />}
          loading={loading}
        />
        <StatCard
          label="Linked Stores"
          value={linkedProvidersCount}
          icon={<StoreIcon />}
          loading={loading}
        />
        <StatCard
          label="Recent (24h)"
          value={stats?.recent24h ?? 0}
          icon={<ClockIcon />}
          loading={loading}
        />
        <StatCard
          label="Server Status"
          value="Active"
          icon={<ActivityIcon />}
          loading={loading}
          trend={{ direction: 'up', label: 'Online' }}
        />
      </div>
    </section>
  );
}
