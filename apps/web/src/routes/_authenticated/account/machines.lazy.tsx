import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createLazyFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { AccountInlineError } from '@/components/account/AccountPage';
import { DashboardAuthRequiredState } from '@/components/dashboard/AuthRequiredState';
import {
  buildBillingStatusCopy,
  CertificateDeviceRow,
} from '@/components/dashboard/CertificateWorkspacePanels';
import { DashboardCertificatesSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { StatusChip } from '@/components/ui/StatusChip';
import { useToast } from '@/components/ui/Toast';
import { useCreatorCertificateWorkspace } from '@/hooks/useCreatorCertificateWorkspace';
import { isDashboardAuthError } from '@/hooks/useDashboardSession';
import { revokeCreatorCertificate } from '@/lib/certificates';

function AccountMachinesPending() {
  return (
    <div id="tab-panel-machines" className="dashboard-tab-panel is-active" role="tabpanel">
      <div className="bento-grid">
        <DashboardCertificatesSkeleton />
      </div>
    </div>
  );
}

export const Route = createLazyFileRoute('/_authenticated/account/machines')({
  pendingComponent: AccountMachinesPending,
  component: AccountMachines,
});

export default function AccountMachines() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [pendingCertNonce, setPendingCertNonce] = useState<string | null>(null);
  const { billing, hasAuthError, isLoading, markSessionExpired, overview, query, status } =
    useCreatorCertificateWorkspace();

  const revokeMut = useMutation({
    mutationFn: (certNonce: string) => revokeCreatorCertificate(certNonce),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['creator-certificates'] });
      toast.success('Device revoked');
    },
    onError: (error) => {
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      toast.error('Could not revoke device', {
        description: 'Contact support if this persists.',
      });
    },
    onSettled: () => setPendingCertNonce(null),
  });

  const hasCertificateAccess = billing?.status === 'active' || billing?.status === 'grace';
  const statusCopy = buildBillingStatusCopy(billing);
  const devices = overview?.devices ?? [];

  const handleRevoke = (certNonce: string) => {
    setPendingCertNonce(certNonce);
    revokeMut.mutate(certNonce);
  };

  if (status === 'signed_out' || status === 'expired') {
    return (
      <div id="tab-panel-machines" className="dashboard-tab-panel is-active" role="tabpanel">
        <DashboardAuthRequiredState
          id="machines-auth"
          title="Sign in to manage machines"
          description="Your session expired. Reconnect to review enrolled machines or revoke a certificate."
        />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div id="tab-panel-machines" className="dashboard-tab-panel is-active" role="tabpanel">
        <div className="bento-grid">
          <DashboardCertificatesSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div id="tab-panel-machines" className="dashboard-tab-panel is-active" role="tabpanel">
      <div className="bento-grid">
        {query.isError && !hasAuthError && (
          <div className="bento-col-12">
            <AccountInlineError message="Failed to load machines. Please refresh." />
          </div>
        )}

        <section className="intg-card animate-in bento-col-12">
          <div className="intg-header">
            <div className="intg-title-row">
              <div className="intg-icon">
                <img src="/Icons/Laptop.png" alt="" aria-hidden="true" />
              </div>
              <div className="intg-copy">
                <h2 className="intg-title">Authorized Machines</h2>
                <p className="intg-desc">
                  Each enrolled machine holds a unique signing certificate. Revoking it takes effect
                  immediately.
                </p>
              </div>
            </div>
            <Link
              to="/account/billing"
              className="account-btn account-btn--secondary"
              style={{ borderRadius: '999px', fontSize: '13px', alignSelf: 'center' }}
            >
              Manage plan
            </Link>
          </div>

          {hasCertificateAccess ? (
            <div className="cert-stat-row">
              <div className="cert-stat-item">
                <span className="cert-stat-label">Devices</span>
                <span className="cert-stat-value">
                  {billing?.activeDeviceCount ?? 0}&thinsp;/&thinsp;{billing?.deviceCap ?? '∞'}
                </span>
                <span className="cert-stat-meta">Enrolled machines using your current plan.</span>
              </div>
              <div className="cert-stat-item">
                <span className="cert-stat-label">Enrollment</span>
                <span className="cert-stat-value">
                  {billing?.allowEnrollment ? 'Open' : 'Closed'}
                </span>
                <span className="cert-stat-meta">
                  {billing?.allowEnrollment
                    ? 'New devices can request a certificate now.'
                    : 'Pause new enrollments until you reopen access.'}
                </span>
              </div>
              <div className="cert-stat-item">
                <span className="cert-stat-label">Signing</span>
                <span className="cert-stat-value">
                  {billing?.allowSigning ? 'Active' : 'Paused'}
                </span>
                <span className="cert-stat-meta">
                  {billing?.allowSigning
                    ? 'Signing requests are accepted for protected builds.'
                    : 'Signing is paused until billing access resumes.'}
                </span>
              </div>
            </div>
          ) : (
            <div className="account-kv-row" style={{ alignItems: 'center', gap: '10px' }}>
              <StatusChip status={statusCopy.badgeStatus} label={statusCopy.badgeLabel} />
              <span className="intg-desc" style={{ margin: 0 }}>
                Existing certificates stay visible for audit and revocation.{' '}
                <Link to="/account/billing" className="billing-hero-link">
                  Activate a plan
                </Link>{' '}
                to enroll new machines.
              </span>
            </div>
          )}
        </section>

        <section className="intg-card animate-in animate-in-delay-1 bento-col-12">
          <div className="account-list">
            {devices.length > 0 ? (
              devices.map((device) => (
                <CertificateDeviceRow
                  key={device.certNonce}
                  device={device}
                  isRevoking={pendingCertNonce === device.certNonce && revokeMut.isPending}
                  onRevoke={handleRevoke}
                />
              ))
            ) : (
              <div className="account-empty">
                <div className="account-empty-icon">
                  <img
                    src="/Icons/Laptop.png"
                    alt=""
                    aria-hidden="true"
                    style={{ width: '20px', height: '20px', objectFit: 'contain', opacity: 0.45 }}
                  />
                </div>
                <p className="account-empty-title">No devices enrolled yet</p>
                <p className="account-empty-desc">
                  Authorize a machine via the CLI or Unity plugin and it will appear here.
                </p>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
