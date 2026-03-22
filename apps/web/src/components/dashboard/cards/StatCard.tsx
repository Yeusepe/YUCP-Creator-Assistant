import { type ReactNode } from 'react';

export interface StatCardProps {
  label: string;
  value: string | number;
  icon: ReactNode;
  trend?: {
    direction: 'up' | 'down' | 'neutral';
    label: string;
  };
  loading?: boolean;
}

function TrendArrow({ direction }: { direction: 'up' | 'down' | 'neutral' }) {
  if (direction === 'neutral') {
    return (
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M5 12h14" />
      </svg>
    );
  }

  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {direction === 'up' ? <path d="M12 19V5m-7 7 7-7 7 7" /> : <path d="M12 5v14m7-7-7 7-7-7" />}
    </svg>
  );
}

export function StatCard({ label, value, icon: _icon, trend, loading }: StatCardProps) {
  if (loading) {
    return (
      <div className="stat-cell" aria-hidden="true">
        <div className="stat-cell-skeleton-val" />
        <div className="stat-cell-skeleton-label" style={{ marginTop: '4px' }} />
      </div>
    );
  }

  return (
    <div className="stat-cell">
      <div className="stat-cell-value">{value}</div>
      <div className="stat-cell-label">{label}</div>
      {trend ? (
        <div className={`stat-cell-trend ${trend.direction}`}>
          <TrendArrow direction={trend.direction} />
          <span>{trend.label}</span>
        </div>
      ) : null}
    </div>
  );
}
