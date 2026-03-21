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
        width="14"
        height="14"
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
      width="14"
      height="14"
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

const TREND_CLASSES: Record<'up' | 'down' | 'neutral', string> = {
  up: 'text-emerald-600 dark:text-emerald-400',
  down: 'text-red-600 dark:text-red-400',
  neutral: 'text-zinc-400 dark:text-zinc-500',
};

function StatCardSkeleton() {
  return (
    <div
      className="flex flex-col gap-3 rounded-2xl border border-zinc-200/60 bg-zinc-50 p-5 dark:border-white/10 dark:bg-zinc-800/50"
      aria-hidden="true"
    >
      <div className="h-10 w-10 animate-pulse rounded-full bg-zinc-200/60 dark:bg-zinc-700/40" />
      <div className="mt-1 h-8 w-24 animate-pulse rounded-lg bg-zinc-200/60 dark:bg-zinc-700/40" />
      <div className="h-4 w-16 animate-pulse rounded bg-zinc-100/60 dark:bg-zinc-800/40" />
    </div>
  );
}

export function StatCard({ label, value, icon, trend, loading }: StatCardProps) {
  if (loading) return <StatCardSkeleton />;

  return (
    <div
      className={[
        'flex flex-col gap-1 rounded-2xl p-5',
        'bg-zinc-50 border border-zinc-200/60',
        'transition-all duration-200',
        'hover:border-zinc-300 hover:shadow-sm',
        'dark:bg-zinc-800/50 dark:border-white/10',
        'dark:hover:border-white/20 dark:hover:bg-zinc-800/70',
      ].join(' ')}
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-sky-100 text-sky-600 dark:bg-sky-900/40 dark:text-sky-400">
        {icon}
      </div>

      <p
        className="mt-2 text-[32px] font-extrabold leading-tight tracking-[-0.04em] text-zinc-900 dark:text-white"
        style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
      >
        {value}
      </p>

      <div className="flex items-center justify-between">
        <span
          className="text-sm text-zinc-500 dark:text-zinc-400"
          style={{ fontFamily: "'DM Sans', sans-serif" }}
        >
          {label}
        </span>

        {trend ? (
          <span
            className={`flex items-center gap-1 text-xs font-medium ${TREND_CLASSES[trend.direction]}`}
          >
            <TrendArrow direction={trend.direction} />
            {trend.label}
          </span>
        ) : null}
      </div>
    </div>
  );
}
