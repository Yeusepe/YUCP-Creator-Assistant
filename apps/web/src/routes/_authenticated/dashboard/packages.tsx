import { createFileRoute, Link } from '@tanstack/react-router';
import { DashboardAuthRequiredState } from '@/components/dashboard/AuthRequiredState';
import { DashboardGridSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { PackageRegistryPanel } from '@/components/dashboard/PackageRegistryPanel';
import { useActiveDashboardContext } from '@/hooks/useActiveDashboardContext';
import { useDashboardSession } from '@/hooks/useDashboardSession';

function DashboardPackagesPending() {
  return (
    <div id="tab-panel-packages" className="dashboard-tab-panel is-active" role="tabpanel">
      <div className="bento-grid">
        <DashboardGridSkeleton cards={3} />
      </div>
    </div>
  );
}

export const Route = createFileRoute('/_authenticated/dashboard/packages')({
  pendingComponent: DashboardPackagesPending,
  component: DashboardPackages,
});

export default function DashboardPackages() {
  const { isPersonalDashboard } = useActiveDashboardContext();
  const { isAuthResolved, status } = useDashboardSession();

  if (status === 'signed_out' || status === 'expired') {
    return (
      <div id="tab-panel-packages" className="dashboard-tab-panel is-active" role="tabpanel">
        <DashboardAuthRequiredState
          id="packages-auth"
          title="Sign in to manage packages"
          description="Your session expired. Sign in again to rename packages, delete unused packages, or reuse a package ID in Unity."
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
                  Package ownership belongs to your creator account. Open the root dashboard to
                  manage package IDs.
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

  if (!isAuthResolved) {
    return (
      <div id="tab-panel-packages" className="dashboard-tab-panel is-active" role="tabpanel">
        <div className="bento-grid">
          <DashboardGridSkeleton cards={3} />
        </div>
      </div>
    );
  }

  return (
    <div id="tab-panel-packages" className="dashboard-tab-panel is-active" role="tabpanel">
      <div className="bento-grid">
        <PackageRegistryPanel description="Package IDs are managed from certificates now. This compatibility view stays available for direct links and Unity handoffs." />
      </div>
    </div>
  );
}
