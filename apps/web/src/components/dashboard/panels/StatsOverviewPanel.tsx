import { useQuery as useConvexQuery } from 'convex/react';
import { StatCard } from '@/components/dashboard/cards/StatCard';
import { api } from '../../../../../../convex/_generated/api';

interface DashboardStats {
  totalVerified: number;
  totalProducts: number;
  recent24h: number;
  recent7d: number;
  recent30d: number;
  totalLicenses: number;
  activeLicenses: number;
}

const STAT_DEFINITIONS = [
  {
    key: 'verified-members',
    label: 'Verified Members',
    getValue: (s: DashboardStats) => s.totalVerified,
    getTrend: (s: DashboardStats) =>
      s.recent24h > 0
        ? { direction: 'up' as const, label: `+${String(s.recent24h)} today` }
        : undefined,
  },
  {
    key: 'active-products',
    label: 'Active Products',
    getValue: (s: DashboardStats) => s.totalProducts,
    getTrend: undefined,
  },
  {
    key: 'verifications-7d',
    label: 'Verifications (7d)',
    getValue: (s: DashboardStats) => s.recent7d,
    getTrend: (s: DashboardStats) => ({
      direction: s.recent24h > 0 ? ('up' as const) : ('neutral' as const),
      label: `${String(s.recent24h)} today`,
    }),
  },
  {
    key: 'active-licenses',
    label: 'Active Licenses',
    getValue: (s: DashboardStats) => s.activeLicenses,
    getTrend: (s: DashboardStats) => ({
      direction: 'neutral' as const,
      label: `${String(s.totalLicenses)} total`,
    }),
  },
];

export function StatsOverviewPanel() {
  const stats = useConvexQuery(api.dashboardViews.getMyDashboardStats);
  const isLoading = stats === undefined;

  return (
    <section
      id="stats-overview-section"
      className="intg-card animate-in"
      aria-label="Dashboard statistics overview"
    >
      <div className="stat-grid">
        {STAT_DEFINITIONS.map((def) => (
          <StatCard
            key={def.key}
            label={def.label}
            value={isLoading ? 0 : def.getValue(stats)}
            icon={null}
            trend={isLoading ? undefined : def.getTrend?.(stats)}
            loading={isLoading}
          />
        ))}
      </div>
    </section>
  );
}
