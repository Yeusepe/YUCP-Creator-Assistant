import type { CSSProperties } from 'react';

import {
  SkeletonCircle,
  SkeletonLine,
  SkeletonPill,
  SkeletonSwitch,
  SkeletonTile,
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

/** Settings tile skeleton, matches the actual svr-cfg-tile layout (56px rows). */
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

/** Billing tab skeleton, matches `billing-layout` (hero + metrics + caps). */
export function DashboardBillingSkeleton() {
  return (
    <div className="bento-col-12 billing-layout-skeleton" aria-hidden="true">
      <div className="billing-skeleton-hero">
        <div className="billing-skeleton-hero-left">
          <SkeletonCircle size="44px" />
          <div className="skeleton-copy" style={copySectionStyle}>
            <SkeletonLine width="48%" />
            <SkeletonLine width="68%" className="skeleton-line-muted" />
          </div>
        </div>
        <div className="billing-skeleton-hero-actions">
          <SkeletonPill width="96px" />
          <SkeletonPill width="152px" />
        </div>
      </div>
      <div className="billing-skeleton-metrics">
        {Array.from({ length: 3 }, (_, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            key={i}
            className="billing-skeleton-metric-tile"
          >
            <SkeletonLine width="52%" />
            <SkeletonLine width="40%" style={{ height: '30px' }} />
            <SkeletonLine width="58%" className="skeleton-line-muted" />
          </div>
        ))}
      </div>
      <div className="billing-skeleton-caps">
        <SkeletonLine width="32%" />
        <div className="billing-skeleton-caps-chips">
          {Array.from({ length: 4 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <SkeletonPill key={i} width={`${84 + (i % 3) * 20}px`} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Certificates page skeleton, matches the 8/4 bento-grid split. */
export function DashboardCertificatesSkeleton() {
  return (
    <>
      {/* Left, 8-col card: header + device rows */}
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

      {/* Right, 4-col card: header + kv rows + button */}
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

export type PackageRegistryWorkspaceSkeletonProps = {
  className?: string;
  showHeader?: boolean;
  listRows?: number;
};

function PackageProductRowSkeleton() {
  return (
    <div className="pm-product-row rounded-xl shadow-none">
      <div className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 flex-1 gap-3">
          <SkeletonTile size={44} radius={12} />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <SkeletonLine width="min(100%, 14rem)" style={{ height: '16px' }} />
              <SkeletonPill width="96px" />
            </div>
            <SkeletonLine width="min(100%, 42rem)" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          <SkeletonPill width="160px" style={{ height: '32px', borderRadius: '8px' }} />
          <SkeletonPill width="96px" style={{ height: '32px', borderRadius: '8px' }} />
        </div>
      </div>
    </div>
  );
}

export function PackageRegistryWorkspaceSkeleton({
  className = 'bento-col-12',
  showHeader = true,
  listRows = 4,
}: PackageRegistryWorkspaceSkeletonProps) {
  return (
    <section
      className={['flex flex-col gap-4', className].filter(Boolean).join(' ')}
      aria-label="Loading packages"
      aria-busy="true"
      aria-live="polite"
    >
      {showHeader ? (
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="max-w-[64ch] space-y-1.5">
            <SkeletonLine width="192px" style={{ height: '32px' }} />
            <SkeletonLine />
            <SkeletonLine width="83.333333%" />
          </div>
          <SkeletonPill width="192px" style={{ height: '40px' }} />
        </div>
      ) : null}

      <div className="pm-card pm-primary-panel rounded-2xl shadow-none">
        <div className="flex flex-col gap-3 p-4 pb-2">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <SkeletonTile size={24} radius={6} />
              <SkeletonLine width="min(100%, 18rem)" style={{ height: '20px' }} />
            </div>
            <SkeletonLine width="min(100%, 52ch)" />
          </div>
        </div>
        <div className="space-y-4 p-4 pt-0">
          <div className="pm-inline-note space-y-2 rounded-[18px] p-3">
            <SkeletonLine width="192px" />
            <SkeletonLine width="min(100%, 50ch)" style={{ height: '12px' }} />
            <SkeletonLine width="min(80%, 46ch)" style={{ height: '12px' }} />
          </div>
          <div className="space-y-3">
            {Array.from({ length: listRows }, (_, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders never reorder
              <PackageProductRowSkeleton key={index} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Provider card skeleton, matches the intg-provider-grid card layout.
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
