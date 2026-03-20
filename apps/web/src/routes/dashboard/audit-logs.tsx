import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/dashboard/audit-logs')({
  component: DashboardAuditLogs,
});

function DashboardAuditLogs() {
  return (
    <div
      id="tab-panel-audit-logs"
      className="dashboard-tab-panel is-active server-only"
      role="tabpanel"
      aria-labelledby="tab-btn-audit-logs"
    >
      <section className="section-card bento-col-12 p-4 sm:p-5 md:p-7 animate-in animate-in-delay-1">
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="w-12 h-12 bg-white/10 rounded-xl flex items-center justify-center mb-4">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-white/60"
              aria-hidden="true"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          </div>
          <h3 className="text-xl font-bold text-white mb-2">Audit Logs coming soon</h3>
          <p
            className="text-white/50 text-sm max-w-sm"
            style={{ fontFamily: "'DM Sans',sans-serif" }}
          >
            View your verification history and member role assignments.
          </p>
        </div>
      </section>
    </div>
  );
}
