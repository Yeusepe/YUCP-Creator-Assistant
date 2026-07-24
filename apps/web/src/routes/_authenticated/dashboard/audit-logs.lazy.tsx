import { createLazyFileRoute } from '@tanstack/react-router';
import { Icon } from '@/components/ui/Icon';

export const Route = createLazyFileRoute('/_authenticated/dashboard/audit-logs')({
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
      <div className="bento-grid">
        <section className="intg-card bento-col-12 animate-in animate-in-delay-1">
          <div className="empty-state" style={{ padding: '40px 24px' }}>
            <div
              className="intg-icon"
              style={{ margin: '0 auto 16px', width: '48px', height: '48px' }}
            >
              <Icon name="auditLog" size={22} />
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
            <p className="empty-state-title">Audit Logs</p>
            <p className="empty-state-copy">
              A full audit trail of verification events, role assignments, and member activity is on
              the way. You will be able to filter by event type, date range, and member.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
