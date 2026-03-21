import { useQuery as useConvexQuery } from 'convex/react';
import { ActivityItem } from '@/components/dashboard/cards/ActivityItem';
import { api } from '../../../../../../convex/_generated/api';

interface ActivityEvent {
  eventType: string;
  actorType: string;
  actorId?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

const EVENT_DESCRIPTIONS: Record<string, (metadata?: Record<string, unknown>) => string> = {
  'entitlement.granted': (metadata) => {
    const product = metadata?.productName ?? metadata?.product_name;
    return product ? `Entitlement granted for ${String(product)}` : 'Entitlement granted';
  },
  'entitlement.revoked': () => 'Entitlement revoked',
  'discord.role.sync.completed': () => 'Discord roles synced',
  'verification.session.completed': () => 'Verification completed',
  'guild.linked': () => 'Server connected',
  'guild.unlinked': () => 'Server disconnected',
  'binding.created': () => 'Account linked',
  'binding.revoked': () => 'Account unlinked',
  'creator.policy.updated': () => 'Settings updated',
};

function humanizeEventType(eventType: string): string {
  return eventType.replace(/\./g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function describeEvent(event: ActivityEvent): string {
  const describer = EVENT_DESCRIPTIONS[event.eventType];
  if (describer) {
    return describer(event.metadata as Record<string, unknown> | undefined);
  }
  return humanizeEventType(event.eventType);
}

function ActivitySkeleton() {
  return (
    <div className="flex items-start gap-3 py-3" aria-hidden="true">
      <div className="h-6 w-6 shrink-0 animate-pulse rounded-full bg-white/30 dark:bg-white/8" />
      <div className="flex flex-1 flex-col gap-1.5">
        <div className="h-4 w-48 animate-pulse rounded bg-white/30 dark:bg-white/8" />
        <div className="h-3 w-16 animate-pulse rounded bg-white/20 dark:bg-white/5" />
      </div>
    </div>
  );
}

export function RecentActivityPanel() {
  const activity = useConvexQuery(api.dashboardViews.listMyRecentActivity);
  const isLoading = activity === undefined;

  return (
    <section
      id="recent-activity-panel"
      className="section-card bento-col-12 animate-in animate-in-delay-2"
      aria-label="Recent activity"
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-6 pt-5 pb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-100 dark:bg-purple-900/40">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-purple-600 dark:text-purple-400"
            aria-hidden="true"
          >
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
        </div>
        <h2
          className="text-base font-bold text-zinc-900 dark:text-white"
          style={{ fontFamily: "'DM Sans', sans-serif" }}
        >
          Recent Activity
        </h2>
      </div>

      {/* Body */}
      <div className="max-h-[400px] overflow-y-auto px-6 pb-6">
        {isLoading ? (
          <div className="flex flex-col">
            {Array.from({ length: 5 }, (_, i) => {
              const skeletonId = `activity-skeleton-${String(i)}`;
              return <ActivitySkeleton key={skeletonId} />;
            })}
          </div>
        ) : activity.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <svg
              width="40"
              height="40"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-zinc-300 dark:text-zinc-600"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <p className="mt-3 text-sm text-zinc-400 dark:text-zinc-500">No recent activity</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {activity.map((event) => (
              <ActivityItem
                key={`${event.eventType}-${String(event.createdAt)}`}
                eventType={event.eventType}
                description={describeEvent(event)}
                timestamp={event.createdAt}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
