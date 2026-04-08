import type { CSSProperties } from 'react';

import {
  SkeletonCircle,
  SkeletonLine,
  SkeletonPill,
  SkeletonSwitch,
} from '@/components/ui/YucpSkeleton';

const copySectionStyle: CSSProperties = { flex: 1 };

type DashboardActionRowSkeletonProps = {
  count?: number;
  widths?: number[];
};

type DashboardListSkeletonProps = {
  rows?: number;
  showAction?: boolean;
};

function DashboardRowSkeleton({ showAction = true }: { showAction?: boolean }) {
  return (
    <div className="skeleton-row-card" aria-hidden="true">
      <SkeletonCircle />
      <div className="skeleton-copy">
        <SkeletonLine width="38%" />
        <SkeletonLine width="62%" className="skeleton-line-muted" />
      </div>
      {showAction ? <SkeletonPill /> : null}
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
        <SkeletonPill key={item.id} width={`${item.width}px`} />
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
          <SkeletonCircle />
          <div className="skeleton-copy" style={copySectionStyle}>
            <SkeletonLine width="42%" />
            <SkeletonLine width="68%" className="skeleton-line-muted" />
          </div>
          <SkeletonSwitch />
        </div>
      ))}
    </div>
  );
}

/** Certificates page skeleton — matches the 8/4 bento-grid split. */
export function DashboardCertificatesSkeleton() {
  return (
    <>
      {/* Left — 8-col card: header + device rows */}
      <div className="intg-card bento-col-8" aria-hidden="true">
        <div className="intg-header">
          <SkeletonCircle size="36px" />
          <div className="skeleton-copy" style={copySectionStyle}>
            <SkeletonLine width="45%" />
            <SkeletonLine width="70%" className="skeleton-line-muted" />
          </div>
        </div>
        <div className="skeleton-stack" style={{ marginTop: '12px' }}>
          {Array.from({ length: 3 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <DashboardRowSkeleton key={i} />
          ))}
        </div>
      </div>

      {/* Right — 4-col card: header + kv rows + button */}
      <div className="intg-card bento-col-4" aria-hidden="true">
        <div className="intg-header">
          <SkeletonCircle size="36px" />
          <div className="skeleton-copy" style={copySectionStyle}>
            <SkeletonLine width="55%" />
            <SkeletonLine width="38%" className="skeleton-line-muted" />
          </div>
        </div>
        <div className="skeleton-stack" style={{ marginTop: '12px' }}>
          {Array.from({ length: 3 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <div key={i} className="skeleton-row-card" style={{ minHeight: '40px' }}>
              <div className="skeleton-copy" style={copySectionStyle}>
                <SkeletonLine width="40%" />
              </div>
              <SkeletonLine width="25%" />
            </div>
          ))}
        </div>
        <SkeletonPill width="100%" />
      </div>
    </>
  );
}

/** Package registry row skeleton — icon + name/id pair + status pill + icon actions. */
function DashboardPackageRowSkeleton() {
  return (
    <div className="pkg-row pkg-row--skeleton" aria-hidden="true">
      <SkeletonCircle size="36px" />
      <div className="pkg-row__body">
        <SkeletonLine width="42%" />
        <SkeletonLine width="60%" className="skeleton-line-muted" />
      </div>
      <SkeletonPill width="56px" />
      <div style={{ display: 'flex', gap: '6px' }}>
        <SkeletonCircle size="30px" />
        <SkeletonCircle size="30px" />
      </div>
    </div>
  );
}

export function DashboardPackageRegistrySkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton-stack" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
        <DashboardPackageRowSkeleton key={i} />
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
            <SkeletonCircle size="40px" />
            <div className="skeleton-copy" style={copySectionStyle}>
              <SkeletonLine width="55%" />
              <SkeletonLine width="38%" className="skeleton-line-muted" />
            </div>
          </div>
          <SkeletonPill width="80px" />
        </div>
      ))}
    </div>
  );
}
