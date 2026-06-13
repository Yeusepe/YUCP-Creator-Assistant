import { useQuery } from '@tanstack/react-query';
import { createLazyFileRoute, Link } from '@tanstack/react-router';
import { useEffect } from 'react';
import { ApiError } from '@/api/client';
import { DashboardAuthRequiredState } from '@/components/dashboard/AuthRequiredState';
import { PackageRegistryWorkspaceSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { PackageRegistryAccessGate } from '@/components/dashboard/PackageRegistryAccessGate';
import { PackageRegistryPanel } from '@/components/dashboard/PackageRegistryPanel';
import { useActiveDashboardContext } from '@/hooks/useActiveDashboardContext';
import { isDashboardAuthError, useDashboardSession } from '@/hooks/useDashboardSession';
import { hasActiveCreatorBillingCapability, listCreatorCertificates } from '@/lib/certificates';
import { useRuntimeConfig } from '@/lib/runtimeConfig';
import { BILLING_CAPABILITY_KEYS } from '../../../../../../convex/lib/billingCapabilities';

function DashboardPackagesLoadingShell() {
  return (
    <div id="tab-panel-packages" className="dashboard-tab-panel is-active" role="tabpanel">
      <div className="bento-grid">
        <PackageRegistryWorkspaceSkeleton showHeader />
      </div>
    </div>
  );
}

function DashboardPackagesPending() {
  return <DashboardPackagesLoadingShell />;
}

function PackageRegistryFeatureDisabledState() {
  return (
    <div id="tab-panel-packages" className="dashboard-tab-panel is-active" role="tabpanel">
      <div className="bento-grid">
        <section className="intg-card animate-in bento-col-12">
          <div className="intg-header">
            <div className="intg-icon">
              <img src="/Icons/Library.png" alt="" aria-hidden="true" />
            </div>
            <div className="intg-copy">
              <h1 className="intg-title">Package registry unavailable</h1>
              <p className="intg-desc">
                Private VPM packages are behind a feature flag and disabled in this environment.
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export const Route = createLazyFileRoute('/_authenticated/dashboard/packages')({
  pendingComponent: DashboardPackagesPending,
  component: DashboardPackages,
});

function noRetryOn4xx(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

export default function DashboardPackages() {
  const { isPersonalDashboard } = useActiveDashboardContext();
  const { canRunPanelQueries, isAuthResolved, markSessionExpired, status } = useDashboardSession();
  const { privateVpmEnabled = false } = useRuntimeConfig();
  const certificatesQuery = useQuery({
    queryKey: ['creator-certificates'],
    queryFn: listCreatorCertificates,
    enabled: privateVpmEnabled && canRunPanelQueries && isPersonalDashboard,
    retry: noRetryOn4xx,
  });

  useEffect(() => {
    if (isDashboardAuthError(certificatesQuery.error)) {
      markSessionExpired();
    }
  }, [certificatesQuery.error, markSessionExpired]);

  const hasVpmRepoCapability = hasActiveCreatorBillingCapability(
    certificatesQuery.data?.billing.capabilities,
    BILLING_CAPABILITY_KEYS.vpmRepo
  );
  const isLoading =
    !isAuthResolved || (canRunPanelQueries && isPersonalDashboard && certificatesQuery.isLoading);
  const hasCapabilityQueryError =
    certificatesQuery.isError && !isDashboardAuthError(certificatesQuery.error);

  if (!privateVpmEnabled) {
    return <PackageRegistryFeatureDisabledState />;
  }

  if (status === 'signed_out' || status === 'expired') {
    return (
      <div id="tab-panel-packages" className="dashboard-tab-panel is-active" role="tabpanel">
        <DashboardAuthRequiredState
          id="packages-auth"
          title="Sign in to manage packages"
          description="Your session expired. Sign in again to upload updates, manage install IDs, or add your repo in VCC."
        />
      </div>
    );
  }

  if (!isPersonalDashboard) {
    return (
      <div id="tab-panel-packages" className="dashboard-tab-panel is-active" role="tabpanel">
        <div className="bento-grid">
          <section className="intg-card animate-in bento-col-12">
            <div className="intg-header">
              <div className="intg-icon">
                <img
                  src="/Icons/Library.png"
                  alt=""
                  aria-hidden="true"
                  style={{ width: '22px', height: '22px', objectFit: 'contain' }}
                />
              </div>
              <div className="intg-copy">
                <h1 className="intg-title">Creator scope required</h1>
                <p className="intg-desc">
                  Package ownership belongs to your Creator Identity. Open the root dashboard to
                  manage install IDs.
                </p>
              </div>
            </div>
            <Link
              to="/dashboard/certificates"
              search={(prev) => ({ ...prev, guild_id: undefined, tenant_id: undefined })}
              className="account-btn account-btn--primary"
              style={{ borderRadius: '999px', alignSelf: 'flex-start' }}
            >
              Switch to creator dashboard
            </Link>
          </section>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return <DashboardPackagesLoadingShell />;
  }

  if (hasCapabilityQueryError) {
    return (
      <div id="tab-panel-packages" className="dashboard-tab-panel is-active" role="tabpanel">
        <div className="bento-grid">
          <PackageRegistryAccessGate
            mode="error"
            isRetrying={certificatesQuery.isFetching}
            onRetry={() => {
              void certificatesQuery.refetch();
            }}
          />
        </div>
      </div>
    );
  }

  if (!hasVpmRepoCapability) {
    return (
      <div id="tab-panel-packages" className="dashboard-tab-panel is-active" role="tabpanel">
        <div className="bento-grid">
          <PackageRegistryAccessGate mode="missing" />
        </div>
      </div>
    );
  }

  return (
    <div id="tab-panel-packages" className="dashboard-tab-panel is-active" role="tabpanel">
      <div className="bento-grid">
        <PackageRegistryPanel />
      </div>
    </div>
  );
}
