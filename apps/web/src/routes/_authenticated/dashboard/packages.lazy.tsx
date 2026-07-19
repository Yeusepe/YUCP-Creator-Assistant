import { createLazyFileRoute, Link } from '@tanstack/react-router';
import { CouplingForensicsPanel } from '@/components/dashboard/CouplingForensicsPanel';
import { PackageRegistryWorkspaceSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { PackageRegistryAccessGate } from '@/components/dashboard/PackageRegistryAccessGate';
import { PackageRegistryPanel } from '@/components/dashboard/PackageRegistryPanel';
import { useCreatorCertificateWorkspace } from '@/hooks/useCreatorCertificateWorkspace';
import { hasActiveCreatorBillingCapability } from '@/lib/certificates';
import { BILLING_CAPABILITY_KEYS } from '../../../../../../convex/lib/billingCapabilities';

export const Route = createLazyFileRoute('/_authenticated/dashboard/packages')({
  pendingComponent: DashboardPackagesPending,
  component: DashboardPackages,
});

function DashboardPackagesPending() {
  return (
    <div id="tab-panel-packages" className="dashboard-tab-panel is-active" role="tabpanel">
      <div className="bento-grid">
        <PackageRegistryWorkspaceSkeleton showHeader />
      </div>
    </div>
  );
}

export default function DashboardPackages() {
  const { view } = Route.useSearch();
  const activeView = view === 'forensics' ? 'forensics' : 'registry';
  const { billing, hasAuthError, isLoading, query } = useCreatorCertificateWorkspace();
  const hasRegistryAccess = hasActiveCreatorBillingCapability(
    billing?.capabilities,
    BILLING_CAPABILITY_KEYS.vpmRepo
  );
  const hasForensicsAccess = hasActiveCreatorBillingCapability(
    billing?.capabilities,
    BILLING_CAPABILITY_KEYS.couplingTraceability
  );

  if (activeView === 'registry' && isLoading) {
    return <DashboardPackagesPending />;
  }

  return (
    <div id="tab-panel-packages" className="dashboard-tab-panel is-active" role="tabpanel">
      <PackageWorkspaceHeader activeView={activeView} hasForensicsAccess={hasForensicsAccess} />
      {activeView === 'forensics' ? (
        <CouplingForensicsPanel />
      ) : (
        <div className="bento-grid">
          {query.isError && !hasAuthError ? (
            <PackageRegistryAccessGate
              mode="error"
              isRetrying={query.isFetching}
              onRetry={() => void query.refetch()}
            />
          ) : hasRegistryAccess ? (
            <PackageRegistryPanel />
          ) : (
            <PackageRegistryAccessGate mode="missing" />
          )}
        </div>
      )}
    </div>
  );
}

function PackageWorkspaceHeader({
  activeView,
  hasForensicsAccess,
}: {
  activeView: 'registry' | 'forensics';
  hasForensicsAccess: boolean;
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
          search={(previous) => ({ ...previous, view: undefined })}
          className={`pm-segment-btn${activeView === 'registry' ? ' is-active' : ''}`}
          aria-current={activeView === 'registry' ? 'page' : undefined}
        >
          Package Registry
        </Link>
        <Link
          to="/dashboard/packages"
          search={(previous) => ({ ...previous, view: 'forensics' })}
          className={`pm-segment-btn${activeView === 'forensics' ? ' is-active' : ''}`}
          aria-current={activeView === 'forensics' ? 'page' : undefined}
        >
          Leak Forensics
          {!hasForensicsAccess ? <span className="pm-segment-badge">Studio+</span> : null}
        </Link>
      </nav>
    </header>
  );
}
