import { createLazyFileRoute } from '@tanstack/react-router';

export const Route = createLazyFileRoute('/_authenticated/dashboard/server-rules')({
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
      <div className="bento-grid">
        <section className="intg-card bento-col-12 animate-in animate-in-delay-1">
          <div className="empty-state" style={{ padding: '40px 24px' }}>
            <div
              className="intg-icon"
              style={{ margin: '0 auto 16px', width: '48px', height: '48px' }}
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            </div>
            <span className="intg-status-badge" style={{ marginBottom: '14px' }}>
              <span
                style={{
                  display: 'inline-block',
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  background: 'currentColor',
                  marginRight: '5px',
                }}
              />
              In development
            </span>
            <p className="empty-state-title">Server Rules</p>
            <p className="empty-state-copy">
              Define product-to-role mappings directly from the dashboard. Roles will be
              automatically assigned or removed when members verify purchases, no bot commands
              required.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
