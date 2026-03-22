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
      <div
        style={{
          width: 24,
          height: 24,
          borderRadius: '50%',
          background: '#f1f5f9',
          flexShrink: 0,
          animation: 'pulse 1.4s ease-in-out infinite',
        }}
      />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div
          style={{
            height: 14,
            width: 180,
            borderRadius: 4,
            background: '#f1f5f9',
            animation: 'pulse 1.4s ease-in-out infinite',
          }}
        />
        <div
          style={{
            height: 11,
            width: 60,
            borderRadius: 4,
            background: '#f8fafc',
            animation: 'pulse 1.4s ease-in-out infinite',
          }}
        />
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
      className="intg-card animate-in animate-in-delay-2"
      aria-label="Recent activity"
    >
      {/* Header */}
      <div className="intg-header">
        <div className="intg-title-row">
          <div className="intg-icon">
            <img src="/Icons/Timer.png" alt="" />
          </div>
          <div className="intg-copy">
            <h2 className="intg-title">Recent Activity</h2>
            <p className="intg-desc">Latest verification and sync events.</p>
          </div>
        </div>
      </div>

      {/* Body */}
      <div>
        {isLoading ? (
          <div className="flex flex-col">
            {Array.from({ length: 5 }, (_, i) => {
              const skeletonId = `activity-skeleton-${String(i)}`;
              return <ActivitySkeleton key={skeletonId} />;
            })}
          </div>
        ) : activity.length === 0 ? (
          <div className="intg-empty-state">
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <p className="intg-empty-state-text">No recent activity</p>
          </div>
        ) : (
          <div className="flex flex-col" style={{ maxHeight: 380, overflowY: 'auto' }}>
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
