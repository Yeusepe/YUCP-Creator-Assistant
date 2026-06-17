import { useQuery } from '@tanstack/react-query';
import { createLazyFileRoute, Link } from '@tanstack/react-router';
import { useEffect } from 'react';
import { ApiError } from '@/api/client';
import { DashboardAuthRequiredState } from '@/components/dashboard/AuthRequiredState';
import { CouplingForensicsPanel } from '@/components/dashboard/CouplingForensicsPanel';
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
  const { view } = Route.useSearch();
  const activeView = view === 'forensics' ? 'forensics' : 'registry';
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
  const hasForensicsCapability = hasActiveCreatorBillingCapability(
    certificatesQuery.data?.billing.capabilities,
    BILLING_CAPABILITY_KEYS.couplingTraceability
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
              to="/dashboard"
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

  if (activeView === 'registry' && hasCapabilityQueryError) {
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

  if (activeView === 'registry' && !hasVpmRepoCapability) {
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
      <PackageWorkspaceHeader
        activeView={activeView}
        hasForensicsCapability={hasForensicsCapability}
      />
      {activeView === 'forensics' ? (
        // ponytail: the panel brings its own bento-grid wrapper; no extra grid here.
        <CouplingForensicsPanel />
      ) : (
        <div className="bento-grid">
          <PackageRegistryPanel />
        </div>
      )}
    </div>
  );
}

function PackageWorkspaceHeader({
  activeView,
  hasForensicsCapability,
}: {
  activeView: 'registry' | 'forensics';
  hasForensicsCapability: boolean;
}) {
  return (
    <header className="pm-workspace-header">
      <div className="pm-workspace-heading">
        <h1 className="pm-workspace-title">Private VPM Registry</h1>
        <p className="pm-workspace-subtitle">
          Publish package updates to your Unity (VCC) repo and trace leaked files back to a buyer,
          all from one workspace.
        </p>
      </div>
      <nav className="pm-workspace-segment" aria-label="VPM workspace views">
        <Link
          to="/dashboard/packages"
          search={(prev) => ({ ...prev, view: undefined })}
          className={`pm-segment-btn${activeView === 'registry' ? ' is-active' : ''}`}
          aria-current={activeView === 'registry' ? 'page' : undefined}
        >
          Package Registry
        </Link>
        <Link
          to="/dashboard/packages"
          search={(prev) => ({ ...prev, view: 'forensics' })}
          className={`pm-segment-btn${activeView === 'forensics' ? ' is-active' : ''}`}
          aria-current={activeView === 'forensics' ? 'page' : undefined}
        >
          Leak Forensics
          {!hasForensicsCapability ? <span className="pm-segment-badge">Studio+</span> : null}
        </Link>
      </nav>
    </header>
  );
}
