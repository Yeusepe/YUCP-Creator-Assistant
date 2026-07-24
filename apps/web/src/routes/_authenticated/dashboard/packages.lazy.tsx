import { createLazyFileRoute, useNavigate } from '@tanstack/react-router';
import { CouplingForensicsPanel } from '@/components/dashboard/CouplingForensicsPanel';
import { PackageRegistryWorkspaceSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { PackageRegistryAccessGate } from '@/components/dashboard/PackageRegistryAccessGate';
import { PackageRegistryPanel } from '@/components/dashboard/PackageRegistryPanel';
import { Icon } from '@/components/ui/Icon';
import { useCreatorCertificateWorkspace } from '@/hooks/useCreatorCertificateWorkspace';
import { hasActiveCreatorBillingCapability } from '@/lib/certificates';
import { BILLING_CAPABILITY_KEYS } from '../../../../../../convex/lib/billingCapabilities';

export const Route = createLazyFileRoute('/_authenticated/dashboard/packages')({
  pendingComponent: DashboardPackagesPending,
  component: DashboardPackages,
});

function DashboardPackagesPending() {
  return (
    <div
      id="packages-uploads-panel"
      className="dashboard-tab-panel is-active"
      role="tabpanel"
      aria-labelledby="packages-uploads-tab"
    >
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
  const hasProtectedExportAccess = hasActiveCreatorBillingCapability(
    billing?.capabilities,
    BILLING_CAPABILITY_KEYS.protectedExports
  );

  if (activeView === 'registry' && isLoading) {
    return <DashboardPackagesPending />;
  }

  return (
    <div className="dashboard-tab-panel is-active">
      <PackageWorkspaceHeader activeView={activeView} hasForensicsAccess={hasForensicsAccess} />
      {activeView === 'forensics' ? (
        <div id="packages-forensics-panel" role="tabpanel" aria-labelledby="packages-forensics-tab">
          <CouplingForensicsPanel />
        </div>
      ) : (
        <div id="packages-uploads-panel" role="tabpanel" aria-labelledby="packages-uploads-tab">
          <div className="bento-grid">
            {query.isError && !hasAuthError ? (
              <PackageRegistryAccessGate
                mode="error"
                isRetrying={query.isFetching}
                onRetry={() => void query.refetch()}
              />
            ) : hasRegistryAccess ? (
              <PackageRegistryPanel canProtectAssets={hasProtectedExportAccess} />
            ) : (
              <PackageRegistryAccessGate mode="missing" />
            )}
          </div>
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
  const navigate = useNavigate();

  const selectView = (view: 'registry' | 'forensics') => {
    void navigate({
      to: '/dashboard/packages',
      search: (previous) => ({
        ...previous,
        view: view === 'forensics' ? 'forensics' : undefined,
      }),
    });
  };

  return (
    <header className="pm-workspace-header">
      <div className="pm-workspace-heading">
        <h1 className="pm-workspace-title">Private VPM Registry</h1>
        <p className="pm-workspace-subtitle">
          Publish package updates to your Unity (VCC) repo and trace leaked files back to a buyer,
          all from one workspace.
        </p>
      </div>
      <div className="pm-workspace-segment" role="tablist" aria-label="Package views">
        <button
          id="packages-uploads-tab"
          type="button"
          role="tab"
          className={`pm-segment-btn${activeView === 'registry' ? ' is-active' : ''}`}
          aria-selected={activeView === 'registry'}
          aria-controls="packages-uploads-panel"
          onClick={() => selectView('registry')}
        >
          <Icon name="upload" className="size-4 shrink-0" />
          Uploads
        </button>
        <button
          id="packages-forensics-tab"
          type="button"
          role="tab"
          className={`pm-segment-btn${activeView === 'forensics' ? ' is-active' : ''}`}
          aria-selected={activeView === 'forensics'}
          aria-controls="packages-forensics-panel"
          onClick={() => selectView('forensics')}
        >
          <Icon name="leakTrace" className="size-4 shrink-0" />
          Leak Tracer
          {!hasForensicsAccess ? <span className="pm-segment-badge">Studio+</span> : null}
        </button>
      </div>
    </header>
  );
}
