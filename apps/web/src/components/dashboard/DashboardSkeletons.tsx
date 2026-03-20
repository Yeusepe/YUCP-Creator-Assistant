import type { CSSProperties } from 'react';

type DashboardActionRowSkeletonProps = {
  count?: number;
  widths?: number[];
};

type DashboardListSkeletonProps = {
  rows?: number;
  showAction?: boolean;
};

function SkeletonBlock({ className, style }: { className: string; style?: CSSProperties }) {
  return <div aria-hidden="true" className={className} style={style} />;
}

function DashboardRowSkeleton({ showAction = true }: { showAction?: boolean }) {
  return (
    <div className="skeleton-row-card" aria-hidden="true">
      <SkeletonBlock className="skeleton-block skeleton-circle" />
      <div className="skeleton-copy">
        <SkeletonBlock className="skeleton-block skeleton-line" style={{ width: '38%' }} />
        <SkeletonBlock
          className="skeleton-block skeleton-line skeleton-line-muted"
          style={{ width: '62%' }}
        />
      </div>
      {showAction ? <SkeletonBlock className="skeleton-block skeleton-pill" /> : null}
    </div>
  );
}

export function DashboardActionRowSkeleton({
  count = 3,
  widths = [132, 156, 144],
}: DashboardActionRowSkeletonProps) {
  const items = Array.from({ length: count }, (_, i) => ({
    id: `action-pill-${i}`,
    width: widths[i] ?? widths[widths.length - 1] ?? 144,
  }));
  return (
    <div className="skeleton-action-row" aria-hidden="true">
      {items.map((item) => (
        <SkeletonBlock
          key={item.id}
          className="skeleton-block skeleton-pill"
          style={{ width: `${item.width}px` }}
        />
      ))}
    </div>
  );
}

export function DashboardGridSkeleton({ cards = 2 }: { cards?: number }) {
  return (
    <div className="skeleton-grid" aria-hidden="true">
      {Array.from({ length: cards }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders never reorder
        <DashboardRowSkeleton key={index} />
      ))}
    </div>
  );
}

export function DashboardListSkeleton({ rows = 2, showAction = true }: DashboardListSkeletonProps) {
  return (
    <div className="skeleton-stack" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders never reorder
        <DashboardRowSkeleton key={index} showAction={showAction} />
      ))}
    </div>
  );
}

/** Settings tile skeleton — matches the actual svr-cfg-tile layout (56px rows). */
export function DashboardSettingsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="skeleton-stack" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders never reorder
        <div key={index} className="skeleton-row-card" style={{ minHeight: '56px' }}>
          <SkeletonBlock className="skeleton-block skeleton-circle" />
          <div className="skeleton-copy" style={{ flex: 1 }}>
            <SkeletonBlock className="skeleton-block skeleton-line" style={{ width: '42%' }} />
            <SkeletonBlock
              className="skeleton-block skeleton-line skeleton-line-muted"
              style={{ width: '68%' }}
            />
          </div>
          <SkeletonBlock className="skeleton-block skeleton-switch" />
        </div>
      ))}
    </div>
  );
}

/**
 * Provider card skeleton — matches the intg-provider-grid card layout.
 * Used for the Store Integrations section while providers are loading.
 */
export function DashboardIntegrationsSkeleton({ cards = 3 }: { cards?: number }) {
  return (
    <div className="skeleton-grid skeleton-intg-grid" aria-hidden="true">
      {Array.from({ length: cards }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders never reorder
        <div key={index} className="skeleton-row-card skeleton-intg-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', width: '100%' }}>
            <SkeletonBlock
              className="skeleton-block skeleton-circle"
              style={{ width: '40px', height: '40px', flexShrink: 0 }}
            />
            <div className="skeleton-copy" style={{ flex: 1 }}>
              <SkeletonBlock className="skeleton-block skeleton-line" style={{ width: '55%' }} />
              <SkeletonBlock
                className="skeleton-block skeleton-line skeleton-line-muted"
                style={{ width: '38%', height: '10px' }}
              />
            </div>
          </div>
          <SkeletonBlock
            className="skeleton-block skeleton-pill"
            style={{ width: '80px', height: '24px', marginTop: '12px', borderRadius: '999px' }}
          />
        </div>
      ))}
    </div>
  );
}
