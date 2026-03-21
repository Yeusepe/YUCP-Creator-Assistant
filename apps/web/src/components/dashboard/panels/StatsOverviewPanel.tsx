import { useQuery as useConvexQuery } from 'convex/react';
import { type ReactNode } from 'react';
import { StatCard } from '@/components/dashboard/cards/StatCard';
import { api } from '../../../../../../convex/_generated/api';

interface StatsOverviewPanelProps {
  connectedPlatformsCount?: number;
  totalPlatformsCount?: number;
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
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function PackageIcon() {
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
      <path d="m16.5 9.4-9-5.19" />
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}

function ShieldCheckIcon() {
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
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function KeyIcon() {
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
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  );
}

interface StatDefinition {
  key: string;
  label: string;
  icon: ReactNode;
  getValue: (stats: DashboardStats) => string | number;
  getTrend?: (
    stats: DashboardStats
  ) => { direction: 'up' | 'down' | 'neutral'; label: string } | undefined;
}

interface DashboardStats {
  totalVerified: number;
  totalProducts: number;
  recent24h: number;
  recent7d: number;
  recent30d: number;
  totalLicenses: number;
  activeLicenses: number;
}

const STAT_DEFINITIONS: StatDefinition[] = [
  {
    key: 'verified-members',
    label: 'Verified Members',
    icon: <UsersIcon />,
    getValue: (s) => s.totalVerified,
    getTrend: (s) =>
      s.recent24h > 0 ? { direction: 'up', label: `+${s.recent24h} today` } : undefined,
  },
  {
    key: 'active-products',
    label: 'Active Products',
    icon: <PackageIcon />,
    getValue: (s) => s.totalProducts,
  },
  {
    key: 'verifications-7d',
    label: 'Verifications (7d)',
    icon: <ShieldCheckIcon />,
    getValue: (s) => s.recent7d,
    getTrend: (s) =>
      s.recent24h > 0
        ? { direction: 'up', label: `${s.recent24h} today` }
        : { direction: 'neutral', label: `${s.recent24h} today` },
  },
  {
    key: 'active-licenses',
    label: 'Active Licenses',
    icon: <KeyIcon />,
    getValue: (s) => s.activeLicenses,
    getTrend: (s) => ({ direction: 'neutral', label: `${s.totalLicenses} total` }),
  },
];

export function StatsOverviewPanel({
  connectedPlatformsCount: _connectedPlatformsCount,
  totalPlatformsCount: _totalPlatformsCount,
}: StatsOverviewPanelProps) {
  const stats = useConvexQuery(api.dashboardViews.getMyDashboardStats);
  const isLoading = stats === undefined;

  return (
    <section
      id="stats-overview-section"
      className="bento-col-12"
      aria-label="Dashboard statistics overview"
    >
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {STAT_DEFINITIONS.map((def) => (
          <StatCard
            key={def.key}
            label={def.label}
            value={isLoading ? 0 : def.getValue(stats)}
            icon={def.icon}
            trend={isLoading ? undefined : def.getTrend?.(stats)}
            loading={isLoading}
          />
        ))}
      </div>
    </section>
  );
}
