import { Skeleton } from '@heroui/react';
import type { CSSProperties } from 'react';

interface SkeletonLineProps {
  width?: string;
  className?: string;
  style?: CSSProperties;
}

export function SkeletonLine({ width, className, style }: SkeletonLineProps) {
  return (
    <Skeleton
      className={['skeleton-line', className].filter(Boolean).join(' ')}
      style={{ width: width ?? '100%', height: '14px', ...style }}
    />
  );
}

export function SkeletonCircle({
  size = '32px',
  className,
}: {
  size?: string;
  className?: string;
}) {
  return (
    <Skeleton
      className={['skeleton-circle', className].filter(Boolean).join(' ')}
      style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0 }}
    />
  );
}

export function SkeletonPill({ width, className, style }: SkeletonLineProps) {
  return (
    <Skeleton
      className={['skeleton-pill', className].filter(Boolean).join(' ')}
      style={{ width: width ?? '80px', height: '20px', borderRadius: '999px', ...style }}
    />
  );
}

export function SkeletonSwitch({ className }: { className?: string }) {
  return (
    <Skeleton
      className={['skeleton-switch', className].filter(Boolean).join(' ')}
      style={{ width: '42px', height: '24px', borderRadius: '999px' }}
    />
  );
}

export function SkeletonRowCard({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <Skeleton
      className={['skeleton-row-card', className].filter(Boolean).join(' ')}
      style={{ height: '64px', borderRadius: '12px', ...style }}
    />
  );
}
