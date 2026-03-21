import { type ReactNode } from 'react';
import { QuickActionCard } from '@/components/dashboard/cards/QuickActionCard';

interface QuickAction {
  key: string;
  label: string;
  description: string;
  icon: ReactNode;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
}

interface QuickActionsPanelProps {
  overrides?: Partial<Record<string, Partial<QuickAction>>>;
}

function LinkIcon() {
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
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
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

function BookIcon() {
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
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

const DEFAULT_ACTIONS: QuickAction[] = [
  {
    key: 'connect-store',
    label: 'Connect a Store',
    description: 'Link a new platform account',
    icon: <LinkIcon />,
    href: '/dashboard',
  },
  {
    key: 'api-keys',
    label: 'API Keys',
    description: 'Manage your API keys',
    icon: <KeyIcon />,
    href: '/dashboard/integrations',
  },
  {
    key: 'documentation',
    label: 'Documentation',
    description: 'View creator guides',
    icon: <BookIcon />,
    href: 'https://creators.yucp.club/docs.html',
  },
];

function mergeActions(
  defaults: QuickAction[],
  overrides?: Partial<Record<string, Partial<QuickAction>>>
): QuickAction[] {
  if (!overrides) return defaults;
  return defaults.map((action) => {
    const override = overrides[action.key];
    return override ? { ...action, ...override } : action;
  });
}

export function QuickActionsPanel({ overrides }: QuickActionsPanelProps) {
  const actions = mergeActions(DEFAULT_ACTIONS, overrides);

  return (
    <section
      id="quick-actions-panel"
      className="section-card bento-col-12 animate-in animate-in-delay-3"
      aria-label="Quick actions"
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-6 pt-5 pb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-900/40">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          >
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
        </div>
        <h2
          className="text-base font-bold text-zinc-900 dark:text-white"
          style={{ fontFamily: "'DM Sans', sans-serif" }}
        >
          Quick Actions
        </h2>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 gap-3 px-6 pb-6 sm:grid-cols-2">
        {actions.map((action) => (
          <QuickActionCard
            key={action.key}
            label={action.label}
            description={action.description}
            icon={action.icon}
            href={action.href}
            onClick={action.onClick}
            disabled={action.disabled}
          />
        ))}
      </div>
    </section>
  );
}
