import { createLazyFileRoute } from '@tanstack/react-router';
import { CouplingForensicsPanel } from '@/components/dashboard/CouplingForensicsPanel';

export const Route = createLazyFileRoute('/_authenticated/dashboard/packages')({
  component: DashboardPackageForensics,
});

export default function DashboardPackageForensics() {
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
