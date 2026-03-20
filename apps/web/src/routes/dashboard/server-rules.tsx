import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/dashboard/server-rules')({
  component: DashboardServerRules,
});

function DashboardServerRules() {
  return (
    <div
      id="tab-panel-server-rules"
      className="dashboard-tab-panel is-active server-only"
      role="tabpanel"
      aria-labelledby="tab-btn-server-rules"
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
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </div>
          <h3 className="text-xl font-bold text-white mb-2">Server Rules coming soon</h3>
          <p
            className="text-white/50 text-sm max-w-sm"
            style={{ fontFamily: "'DM Sans',sans-serif" }}
          >
            Define product-to-role mappings directly from your dashboard.
          </p>
        </div>
      </section>
    </div>
  );
}
