import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { isDashboardAuthError, useDashboardSession } from '@/hooks/useDashboardSession';
import { type CreatorCertificateWorkspace, listCreatorCertificates } from '@/lib/certificates';

export function findCurrentCertificatePlan(overview: CreatorCertificateWorkspace | undefined) {
  if (!overview) {
    return null;
  }

  return (
    overview.availablePlans.find(
      (plan) =>
        plan.productId === overview.billing.productId ||
        plan.productId === overview.billing.planKey ||
        plan.planKey === overview.billing.planKey
    ) ?? null
  );
}

export function useCreatorCertificateWorkspace() {
  const { canRunPanelQueries, isAuthResolved, markSessionExpired, status } = useDashboardSession();

  const query = useQuery({
    queryKey: ['creator-certificates'],
    queryFn: listCreatorCertificates,
    enabled: canRunPanelQueries,
  });

  useEffect(() => {
    if (isDashboardAuthError(query.error)) {
      markSessionExpired();
    }
  }, [markSessionExpired, query.error]);

  const overview = query.data;
  const billing = overview?.billing;
  const currentPlan = useMemo(() => findCurrentCertificatePlan(overview), [overview]);
  const isLoading = !isAuthResolved || (canRunPanelQueries && query.isLoading);
  const hasAuthError = isDashboardAuthError(query.error);

  return {
    billing,
    canRunPanelQueries,
    currentPlan,
    hasAuthError,
    isAuthResolved,
    isLoading,
    markSessionExpired,
    overview,
    query,
    status,
  };
}
