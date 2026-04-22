import { useQuery as useConvexQuery } from 'convex/react';
import { Activity, KeyRound, LayoutGrid, ShieldCheck, Users } from 'lucide-react';
import type { ReactNode } from 'react';
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

function dashboardStatsInsight(s: DashboardStats): string {
  if (s.totalVerified === 0 && s.recent7d === 0) {
    return 'Link a storefront and run buyer verification to populate these metrics.';
  }
  if (s.recent24h > 0) {
    return `${String(s.recent24h)} verification${s.recent24h === 1 ? '' : 's'} in the last 24 hours.`;
  }
  if (s.recent7d > 0) {
    return `${String(s.recent7d)} verification${s.recent7d === 1 ? '' : 's'} in the last 7 days.`;
  }
  return 'All quiet in the last 24 hours. Confirm your stores are linked, or run a test verification to make sure everything’s working.';
}

const STAT_DEFINITIONS: ReadonlyArray<{
  key: string;
  label: string;
  icon: ReactNode;
  getValue: (s: DashboardStats) => number;
  getTrend?: (s: DashboardStats) =>
    | {
        direction: 'up' | 'down' | 'neutral';
        label: string;
      }
    | undefined;
  loadingTrendRow: boolean;
  getHint?: (s: DashboardStats) => string | undefined;
}> = [
  {
    key: 'verified-members',
    label: 'Verified members',
    icon: <Users size={18} strokeWidth={1.75} aria-hidden />,
    getValue: (s) => s.totalVerified,
    getTrend: (s) =>
      s.recent24h > 0
        ? { direction: 'up' as const, label: `+${String(s.recent24h)} today` }
        : undefined,
    loadingTrendRow: false,
    getHint: (s) =>
      s.totalVerified > 0 ? 'People who completed verification' : 'Nobody verified yet',
  },
  {
    key: 'active-products',
    label: 'Active products',
    icon: <LayoutGrid size={18} strokeWidth={1.75} aria-hidden />,
    getValue: (s) => s.totalProducts,
    loadingTrendRow: false,
    getHint: () => 'Listed SKUs you can verify against',
  },
  {
    key: 'verifications-7d',
    label: 'Verifications (7d)',
    icon: <ShieldCheck size={18} strokeWidth={1.75} aria-hidden />,
    getValue: (s) => s.recent7d,
    getTrend: (s) => ({
      direction: s.recent24h > 0 ? ('up' as const) : ('neutral' as const),
      label: `${String(s.recent24h)} today`,
    }),
    loadingTrendRow: true,
    getHint: (s) =>
      s.recent30d > s.recent7d ? `${String(s.recent30d)} in the last 30 days` : undefined,
  },
  {
    key: 'active-licenses',
    label: 'Active licenses',
    icon: <KeyRound size={18} strokeWidth={1.75} aria-hidden />,
    getValue: (s) => s.activeLicenses,
    getTrend: (s) => ({
      direction: 'neutral' as const,
      label: `${String(s.totalLicenses)} total`,
    }),
    loadingTrendRow: true,
    getHint: () => 'Seats currently entitled to your goods',
  },
];

export function StatsOverviewPanel() {
  const stats = useConvexQuery(api.dashboardViews.getMyDashboardStats);
  const isLoading = stats == null;
  const sectionClassName = [
    'section-card',
    'dash-home-pulse',
    'stats-overview-panel',
    'animate-in',
    isLoading ? 'stats-overview-panel--loading' : null,
  ]
    .filter(Boolean)
    .join(' ');

  const insight = stats ? dashboardStatsInsight(stats) : '';

  return (
    <section
      id="stats-overview-section"
      className={sectionClassName}
      aria-label="Verification metrics"
    >
      <header className="dash-home-pulse__header">
        <div className="dash-home-pulse__leading" aria-hidden>
          <Activity strokeWidth={1.75} />
        </div>
        <div className="dash-home-pulse__copy">
          <h2 className="dash-home-pulse__title">Verification metrics</h2>
          <p className="dash-home-pulse__lead">
            {isLoading ? 'Loading your verification snapshot…' : insight}
          </p>
        </div>
      </header>
      <div className="dash-home-pulse__grid">
        {STAT_DEFINITIONS.map((def) => (
          <StatCard
            key={def.key}
            label={def.label}
            value={isLoading ? 0 : def.getValue(stats)}
            icon={def.icon}
            trend={isLoading ? undefined : def.getTrend?.(stats)}
            hint={isLoading ? undefined : def.getHint?.(stats)}
            loading={isLoading}
            loadingTrendRow={def.loadingTrendRow}
          />
        ))}
      </div>
    </section>
  );
}
