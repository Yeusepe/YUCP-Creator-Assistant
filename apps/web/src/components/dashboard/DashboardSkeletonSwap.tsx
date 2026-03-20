import type { PropsWithChildren, ReactNode } from 'react';

interface DashboardSkeletonSwapProps extends PropsWithChildren {
  contentClassName?: string;
  contentId?: string;
  isLoading: boolean;
  skeleton: ReactNode;
}

export function DashboardSkeletonSwap({
  children,
  contentClassName,
  contentId,
  isLoading,
  skeleton,
}: DashboardSkeletonSwapProps) {
  if (isLoading) {
    return <>{skeleton}</>;
  }

  if (!contentClassName && !contentId) {
    return <>{children}</>;
  }

  return (
    <div id={contentId} className={contentClassName}>
      {children}
    </div>
  );
}
