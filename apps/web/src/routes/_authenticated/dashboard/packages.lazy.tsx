import { createLazyFileRoute } from '@tanstack/react-router';
import { CouplingForensicsPanel } from '@/components/dashboard/CouplingForensicsPanel';
import { DashboardIntegrationsSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { PackageRegistryAccessGate } from '@/components/dashboard/PackageRegistryAccessGate';
import { PackageUploadPanel } from '@/components/dashboard/PackageUploadPanel';
import { useCreatorCertificateWorkspace } from '@/hooks/useCreatorCertificateWorkspace';
import { hasActiveCreatorBillingCapability } from '@/lib/certificates';
import { BILLING_CAPABILITY_KEYS } from '../../../../../../convex/lib/billingCapabilities';

export const Route = createLazyFileRoute('/_authenticated/dashboard/packages')({
  component: DashboardPackageForensics,
});

export default function DashboardPackageForensics() {
  const { view } = Route.useSearch();
  return view === 'forensics' ? <PackageForensicsWorkspace /> : <PackageUploadWorkspace />;
}

function PackageForensicsWorkspace() {
  return (
    <div id="tab-panel-packages" className="dashboard-tab-panel is-active" role="tabpanel">
      <header className="pm-workspace-header">
        <div className="pm-workspace-heading">
          <h1 className="pm-workspace-title">Leak Forensics</h1>
          <p className="pm-workspace-subtitle">
            Trace leaked files back to a buyer from your creator workspace.
          </p>
        </div>
      </header>
      <CouplingForensicsPanel />
    </div>
  );
}

function PackageUploadWorkspace() {
  const { billing, hasAuthError, isLoading, query } = useCreatorCertificateWorkspace();
  const hasUploadAccess = hasActiveCreatorBillingCapability(
    billing?.capabilities,
    BILLING_CAPABILITY_KEYS.vpmRepo
  );

  return (
    <div id="tab-panel-packages" className="dashboard-tab-panel is-active" role="tabpanel">
      <header className="pm-workspace-header">
        <div className="pm-workspace-heading">
          <h1 className="pm-workspace-title">Package uploads</h1>
          <p className="pm-workspace-subtitle">
            Send creator-owned package releases to resumable storage.
          </p>
        </div>
      </header>
      <div className="bento-grid">
        {isLoading ? (
          <DashboardIntegrationsSkeleton cards={1} />
        ) : query.isError && !hasAuthError ? (
          <PackageRegistryAccessGate
            mode="error"
            isRetrying={query.isFetching}
            onRetry={() => void query.refetch()}
          />
        ) : hasUploadAccess ? (
          <PackageUploadPanel />
        ) : (
          <PackageRegistryAccessGate mode="missing" />
        )}
      </div>
    </div>
  );
}
