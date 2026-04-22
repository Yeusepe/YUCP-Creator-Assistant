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
  /** When loading, show a third skeleton row matching trend height */
  loadingTrendRow?: boolean;
  /** Optional short context under the trend */
  hint?: string;
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

export function StatCard({
  label,
  value,
  icon,
  trend,
  loading,
  loadingTrendRow = false,
  hint,
}: StatCardProps) {
  if (loading) {
    return (
      <div className="dash-metric dash-metric--loading" aria-hidden="true">
        <div className="dash-metric-skel-head">
          <div className="dash-metric-skel-icon" />
          <div className="dash-metric-skel-label" />
        </div>
        <div className="dash-metric-skel-val" />
        {loadingTrendRow ? (
          <div className="dash-metric-skel-trend">
            <div className="dash-metric-skel-trend-i" />
            <div className="dash-metric-skel-trend-t" />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="dash-metric">
      <div className="dash-metric__head">
        <span className="dash-metric__icon" aria-hidden>
          {icon}
        </span>
        <p className="dash-metric__label">{label}</p>
      </div>
      <div className="dash-metric__value">{value}</div>
      {trend ? (
        <div className={`dash-metric__trend ${trend.direction}`}>
          <TrendArrow direction={trend.direction} />
          <span>{trend.label}</span>
        </div>
      ) : null}
      {hint ? <p className="dash-metric__hint">{hint}</p> : null}
    </div>
  );
}
