import { Card, Skeleton } from '@heroui/react';
import type { CSSProperties } from 'react';

import {
  SkeletonCircle,
  SkeletonLine,
  SkeletonPill,
  SkeletonSwitch,
  SkeletonTile,
} from '@/components/ui/YucpSkeleton';

const copySectionStyle: CSSProperties = { flex: 1 };
const packageWorkspaceCardKeys = [
  'registry-summary',
  'package-health',
  'package-targets',
  'package-activity',
] as const;
const packageWorkspaceSideKeys = ['repo-access', 'release-targets', 'supporting-actions'] as const;

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
  /** Full page (route loading) or content only (panel queries while header stays real). */
  showHeader?: boolean;
  listRows?: number;
};

/**
 * Layout mirrors `PackageRegistryPanel` (header, `Card` header + content, inline note, product rows).
 * `Skeleton` uses the default per-element shimmer
 * (https://www.heroui.com/docs/react/components/skeleton), not the optional "Single Shimmer" pattern
 * that wraps a group in `skeleton--shimmer` and sets `animationType="none"` on every child.
 */
function ProductLaneRowSkeleton() {
  return (
    <div className="pm-product-row rounded-xl shadow-none">
      <div className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 flex-1 gap-3">
          <Skeleton className="size-11 shrink-0 rounded-xl" />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Skeleton className="h-4 w-[min(100%,14rem)] rounded" />
              <Skeleton className="h-5 w-24 rounded-full" />
            </div>
            <Skeleton className="h-4 w-full max-w-2xl rounded" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          <Skeleton className="h-8 w-40 max-w-full rounded-lg" />
          <Skeleton className="h-8 w-24 rounded-lg" />
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
            <Skeleton className="h-8 w-48 max-w-full rounded-md" />
            <Skeleton className="h-4 w-full rounded" />
            <Skeleton className="h-4 w-5/6 rounded" />
          </div>
          <Skeleton className="h-10 w-48 shrink-0 rounded-full" />
        </div>
      ) : null}

      <div className="flex w-full min-w-0 flex-col gap-4">
        <Card className="pm-card pm-primary-panel rounded-2xl shadow-none">
          <Card.Header className="flex flex-col gap-3 p-4 pb-2">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Skeleton className="size-6 shrink-0 rounded-md" />
                <Skeleton className="h-5 w-72 max-w-full rounded-md" />
              </div>
              <Skeleton className="h-4 w-full max-w-[52ch] rounded" />
            </div>
          </Card.Header>
          <Card.Content className="space-y-4 p-4 pt-0">
            <div className="pm-inline-note space-y-2 rounded-[18px] p-3">
              <Skeleton className="h-4 w-48 rounded" />
              <Skeleton className="h-3 w-full max-w-[50ch] rounded" />
              <Skeleton className="h-3 w-4/5 max-w-[46ch] rounded" />
            </div>
            <div className="space-y-3">
              {Array.from({ length: listRows }, (_, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
                <ProductLaneRowSkeleton key={index} />
              ))}
            </div>
          </Card.Content>
        </Card>
      </div>
    </section>
  );
}

export function DashboardBackstageWorkspaceSkeleton() {
  return (
    <div className="space-y-4" aria-hidden="true">
      <div className="rounded-[28px] border border-border/70 bg-surface/80 p-6">
        <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
          <div className="flex min-w-0 gap-4">
            <SkeletonTile size={56} radius={18} />
            <div className="flex-1 space-y-3">
              <SkeletonPill width="128px" />
              <SkeletonLine width="220px" style={{ height: '24px' }} />
              <SkeletonLine width="72%" className="skeleton-line-muted" />
              <div className="flex flex-wrap gap-2 pt-1">
                <SkeletonPill width="116px" />
                <SkeletonPill width="132px" />
                <SkeletonPill width="104px" />
              </div>
            </div>
          </div>
          <div className="w-full max-w-[340px] rounded-[24px] border border-border/60 bg-surface-secondary/70 p-4">
            <div className="space-y-3">
              <SkeletonLine width="46%" />
              <SkeletonLine width="78%" className="skeleton-line-muted" />
              <div className="flex flex-wrap gap-2 pt-1">
                <SkeletonPill width="144px" />
                <SkeletonPill width="120px" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
          <div key={index} className="rounded-2xl border border-border/70 bg-surface/80 p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 space-y-3">
                <SkeletonLine width="48%" />
                <SkeletonLine width="26%" style={{ height: '26px' }} />
                <SkeletonLine width="72%" className="skeleton-line-muted" />
              </div>
              <SkeletonTile size={44} radius={16} />
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.2fr_0.95fr]">
        <div className="rounded-[28px] border border-border/70 bg-surface/90 p-6">
          <div className="space-y-4">
            <div className="space-y-2">
              <SkeletonLine width="28%" />
              <SkeletonLine width="64%" className="skeleton-line-muted" />
            </div>
            <div className="rounded-2xl border border-border/60 bg-surface-secondary/70 p-4">
              <SkeletonLine width="42%" />
              <SkeletonLine width="74%" className="skeleton-line-muted" />
              <div className="mt-3 flex flex-wrap gap-2">
                <SkeletonPill width="142px" />
                <SkeletonPill width="118px" />
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {packageWorkspaceCardKeys.map((key) => (
                <div
                  key={key}
                  className="rounded-2xl border border-border/60 bg-surface-secondary/60 p-4"
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 space-y-2">
                        <SkeletonLine width="56%" />
                        <SkeletonLine width="72%" className="skeleton-line-muted" />
                      </div>
                      <SkeletonTile size={38} radius={14} />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <SkeletonPill width="88px" />
                      <SkeletonPill width="102px" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="rounded-[28px] border border-border/70 bg-surface/90 p-6">
          <div className="space-y-4">
            <div className="space-y-2">
              <SkeletonLine width="34%" />
              <SkeletonLine width="70%" className="skeleton-line-muted" />
            </div>
            <div className="space-y-3">
              {packageWorkspaceSideKeys.map((key) => (
                <div
                  key={key}
                  className="rounded-2xl border border-border/60 bg-surface-secondary/60 p-4"
                >
                  <div className="space-y-3">
                    <SkeletonLine width="38%" />
                    <SkeletonLine width="82%" className="skeleton-line-muted" />
                    <div className="flex flex-wrap gap-2">
                      <SkeletonPill width="128px" />
                      <SkeletonPill width="112px" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
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

/** Forensics tab, mirrors `section.intg-card.bento-col-12` (Leak Tracer form). */
export function DashboardForensicsSkeleton() {
  return (
    <section className="intg-card animate-in bento-col-12" aria-hidden="true">
      <div className="intg-header">
        <div className="intg-title-row">
          <SkeletonTile size={40} radius={12} />
          <div className="skeleton-copy" style={copySectionStyle}>
            <SkeletonLine width="32%" />
            <SkeletonLine width="62%" className="skeleton-line-muted" />
          </div>
        </div>
        <SkeletonPill width="124px" />
      </div>

      <div className="forensics-steps">
        <div className="forensics-step">
          <SkeletonCircle size="26px" />
          <div className="forensics-step-body">
            <SkeletonLine width="44%" style={{ marginBottom: 8 }} />
            <SkeletonLine width="100%" style={{ height: 40, borderRadius: 10 }} />
          </div>
        </div>
        <div className="forensics-step">
          <SkeletonCircle size="26px" />
          <div className="forensics-step-body">
            <SkeletonLine width="38%" style={{ marginBottom: 8 }} />
            <div
              className="skeleton-block"
              style={{
                width: '100%',
                height: 132,
                borderRadius: 12,
              }}
            />
          </div>
        </div>
      </div>

      <div className="account-form-actions">
        <SkeletonPill width="168px" style={{ height: 40, borderRadius: 999 }} />
      </div>
    </section>
  );
}
