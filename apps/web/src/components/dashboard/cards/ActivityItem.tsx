import { type ReactNode } from 'react';

export interface ActivityItemProps {
  eventType: string;
  description: string;
  timestamp: number;
  icon?: ReactNode;
  accentColor?: string;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

export function formatRelativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;

  if (delta < 30 * SECOND) return 'just now';
  if (delta < MINUTE) return `${Math.floor(delta / SECOND)}s ago`;
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < WEEK) return `${Math.floor(delta / DAY)}d ago`;
  if (delta < MONTH) return `${Math.floor(delta / WEEK)}w ago`;
  if (delta < YEAR) return `${Math.floor(delta / MONTH)}mo ago`;
  return `${Math.floor(delta / YEAR)}y ago`;
}

interface EventVisuals {
  icon: ReactNode;
  colorClasses: string;
  bgClasses: string;
}

function CheckIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function DiscordIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

function ShieldIcon() {
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
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function ServerIcon() {
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
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" />
      <line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  );
}

function DotIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
      <circle cx="4" cy="4" r="3" fill="currentColor" />
    </svg>
  );
}

const EVENT_VISUALS: Record<string, Omit<EventVisuals, 'icon'> & { icon: () => ReactNode }> = {
  'entitlement.granted': {
    icon: () => <CheckIcon />,
    colorClasses: 'text-emerald-600 dark:text-emerald-400',
    bgClasses: 'bg-emerald-100 dark:bg-emerald-900/40',
  },
  'entitlement.revoked': {
    icon: () => <XIcon />,
    colorClasses: 'text-red-600 dark:text-red-400',
    bgClasses: 'bg-red-100 dark:bg-red-900/40',
  },
  'discord.role.sync.completed': {
    icon: () => <DiscordIcon />,
    colorClasses: 'text-indigo-600 dark:text-indigo-400',
    bgClasses: 'bg-indigo-100 dark:bg-indigo-900/40',
  },
  'verification.session.completed': {
    icon: () => <ShieldIcon />,
    colorClasses: 'text-purple-600 dark:text-purple-400',
    bgClasses: 'bg-purple-100 dark:bg-purple-900/40',
  },
  'guild.linked': {
    icon: () => <ServerIcon />,
    colorClasses: 'text-amber-600 dark:text-amber-400',
    bgClasses: 'bg-amber-100 dark:bg-amber-900/40',
  },
  'guild.unlinked': {
    icon: () => <ServerIcon />,
    colorClasses: 'text-amber-600 dark:text-amber-400',
    bgClasses: 'bg-amber-100 dark:bg-amber-900/40',
  },
};

const DEFAULT_VISUALS = {
  icon: () => <DotIcon />,
  colorClasses: 'text-zinc-400 dark:text-zinc-500',
  bgClasses: 'bg-zinc-100 dark:bg-zinc-800',
};

function getEventVisuals(
  eventType: string,
  customIcon?: ReactNode,
  customColor?: string
): EventVisuals {
  const preset = EVENT_VISUALS[eventType] ?? DEFAULT_VISUALS;

  return {
    icon: customIcon ?? preset.icon(),
    colorClasses: customColor ? '' : preset.colorClasses,
    bgClasses: customColor ? '' : preset.bgClasses,
  };
}

export function ActivityItem({
  eventType,
  description,
  timestamp,
  icon: customIcon,
  accentColor,
}: ActivityItemProps) {
  const visuals = getEventVisuals(eventType, customIcon, accentColor);

  return (
    <div className="flex items-start gap-3 border-b border-zinc-200/60 py-3 last:border-b-0 dark:border-white/10">
      {/* Event icon */}
      <div
        className={[
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
          accentColor ? '' : `${visuals.bgClasses} ${visuals.colorClasses}`,
        ]
          .filter(Boolean)
          .join(' ')}
        style={accentColor ? { backgroundColor: accentColor, color: '#fff' } : undefined}
      >
        {visuals.icon}
      </div>

      {/* Content */}
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className="text-sm text-zinc-700 dark:text-zinc-300"
          style={{ fontFamily: "'DM Sans', sans-serif" }}
        >
          {description}
        </span>
        <time
          className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500"
          dateTime={new Date(timestamp).toISOString()}
        >
          {formatRelativeTime(timestamp)}
        </time>
      </div>
    </div>
  );
}
