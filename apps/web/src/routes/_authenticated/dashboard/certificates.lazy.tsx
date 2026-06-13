import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createLazyFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { AccountInlineError } from '@/components/account/AccountPage';
import { DashboardAuthRequiredState } from '@/components/dashboard/AuthRequiredState';
import {
  buildBillingStatusCopy,
  CertificateDeviceRow,
  CertificateFeatureShowcase,
} from '@/components/dashboard/CertificateWorkspacePanels';
import { DashboardCertificatesSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { PackageRegistryAccessGate } from '@/components/dashboard/PackageRegistryAccessGate';
import { PackageRegistryPanel } from '@/components/dashboard/PackageRegistryPanel';
import { StatusChip } from '@/components/ui/StatusChip';
import { useToast } from '@/components/ui/Toast';
import { useActiveDashboardContext } from '@/hooks/useActiveDashboardContext';
import { useCreatorCertificateWorkspace } from '@/hooks/useCreatorCertificateWorkspace';
import { isDashboardAuthError } from '@/hooks/useDashboardSession';
import {
  formatCertificateDate,
  hasActiveCreatorBillingCapability,
  revokeCreatorCertificate,
} from '@/lib/certificates';
import { useRuntimeConfig } from '@/lib/runtimeConfig';
import { BILLING_CAPABILITY_KEYS } from '../../../../../../convex/lib/billingCapabilities';

function DashboardCertificatesPending() {
  return (
    <div id="tab-panel-certificates" className="dashboard-tab-panel is-active" role="tabpanel">
      <div className="bento-grid">
        <DashboardCertificatesSkeleton />
      </div>
    </div>
  );
}

export const Route = createLazyFileRoute('/_authenticated/dashboard/certificates')({
  pendingComponent: DashboardCertificatesPending,
  component: DashboardCertificates,
});

export default function DashboardCertificates() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [pendingCertNonce, setPendingCertNonce] = useState<string | null>(null);
  const { isPersonalDashboard } = useActiveDashboardContext();
  const { privateVpmEnabled = false } = useRuntimeConfig();
  const {
    billing,
    currentPlan,
    hasAuthError,
    isLoading,
    markSessionExpired,
    overview,
    query,
    status,
  } = useCreatorCertificateWorkspace();

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
  const hasPackageRegistryAccess = hasActiveCreatorBillingCapability(
    billing?.capabilities,
    BILLING_CAPABILITY_KEYS.vpmRepo
  );
  const hasPackageRegistryCapabilityError = query.isError && !hasAuthError;
  const statusCopy = buildBillingStatusCopy(billing);

  const handleRevoke = (certNonce: string) => {
    setPendingCertNonce(certNonce);
    revokeMut.mutate(certNonce);
  };

  if (status === 'signed_out' || status === 'expired') {
    return (
      <div id="tab-panel-certificates" className="dashboard-tab-panel is-active" role="tabpanel">
        <DashboardAuthRequiredState
          id="cert-auth"
          title="Sign in to manage certificates"
          description="Your session expired. Reconnect to review enrolled machines or revoke a certificate."
        />
      </div>
    );
  }

  if (!isPersonalDashboard) {
    return (
      <div id="tab-panel-certificates" className="dashboard-tab-panel is-active" role="tabpanel">
        <div className="bento-grid">
          <section className="intg-card animate-in bento-col-12">
            <div className="intg-header">
              <div className="intg-icon">
                <img
                  src="/Icons/Shield.png"
                  alt=""
                  aria-hidden="true"
                  style={{ width: '22px', height: '22px', objectFit: 'contain' }}
                />
              </div>
              <div className="intg-copy" style={{ flex: 1 }}>
                <h1 className="intg-title">Creator scope required</h1>
                <p className="intg-desc">
                  Certificates belong to your Creator Identity. Return to your root dashboard to
                  manage enrolled machines and revocations.
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

  if (isLoading) {
    return (
      <div id="tab-panel-certificates" className="dashboard-tab-panel is-active" role="tabpanel">
        <div className="bento-grid">
          <DashboardCertificatesSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div id="tab-panel-certificates" className="dashboard-tab-panel is-active" role="tabpanel">
      <div className="bento-grid">
        {query.isError && !hasAuthError && (
          <div className="bento-col-12">
            <AccountInlineError message="Failed to load certificate workspace. Please refresh." />
          </div>
        )}

        <section className="intg-card animate-in bento-col-8">
          <div className="intg-header">
            <div className="intg-title-row">
              <div className="intg-icon">
                <img src="/Icons/Shield.png" alt="" aria-hidden="true" />
              </div>
              <div className="intg-copy">
                <h2 className="intg-title">Code Signing Certificates</h2>
                <p className="intg-desc">
                  Certificate lifecycle stays here. Billing, plan changes, and checkout now live on
                  the dedicated Polar billing page.
                </p>
              </div>
            </div>
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
            <CertificateFeatureShowcase />
          )}
        </section>

        <section className="intg-card animate-in animate-in-delay-1 bento-col-4">
          <div className="intg-header">
            <div className="intg-icon">
              <img
                src="/Icons/BagPlus.png"
                alt=""
                aria-hidden="true"
                style={{ width: '22px', height: '22px', objectFit: 'contain' }}
              />
            </div>
            <div className="intg-copy">
              <h2 className="intg-title">{currentPlan?.displayName ?? 'Billing Status'}</h2>
              <p className="intg-desc">{statusCopy.description}</p>
            </div>
          </div>

          <dl className="account-kv-list">
            <div className="account-kv-row">
              <dt className="account-kv-label">Status</dt>
              <dd>
                <StatusChip status={statusCopy.badgeStatus} label={statusCopy.badgeLabel} />
              </dd>
            </div>
            <div className="account-kv-row">
              <dt className="account-kv-label">Billing</dt>
              <dd className="account-kv-value">Managed in Polar</dd>
            </div>
            <div className="account-kv-row">
              <dt className="account-kv-label">Current Plan</dt>
              <dd className="account-kv-value">{currentPlan?.displayName ?? 'None'}</dd>
            </div>
            {billing?.currentPeriodEnd && (
              <div className="account-kv-row">
                <dt className="account-kv-label">Period End</dt>
                <dd className="account-kv-value">
                  {formatCertificateDate(billing.currentPeriodEnd)}
                </dd>
              </div>
            )}
          </dl>

          <div
            style={{
              marginTop: '16px',
              paddingTop: '14px',
              borderTop: '1px solid rgba(148,163,184,0.15)',
            }}
          >
            <Link
              to="/dashboard/billing"
              search={(prev) => ({ ...prev, guild_id: undefined, tenant_id: undefined })}
              className="account-btn account-btn--primary"
              style={{ width: '100%', justifyContent: 'center', borderRadius: '999px' }}
            >
              Open Billing
            </Link>
          </div>
        </section>

        <section className="intg-card animate-in animate-in-delay-2 bento-col-12">
          <div className="intg-header">
            <div className="intg-icon">
              <img
                src="/Icons/Laptop.png"
                alt=""
                aria-hidden="true"
                style={{ width: '22px', height: '22px', objectFit: 'contain' }}
              />
            </div>
            <div className="intg-copy">
              <h2 className="intg-title">
                {hasCertificateAccess ? 'Authorized Machines' : 'Stored Machine Certificates'}
              </h2>
              <p className="intg-desc">
                {hasCertificateAccess
                  ? 'Each enrolled machine holds a unique signing certificate. Revoking it takes effect immediately.'
                  : 'Existing certificate records remain visible for audit and revocation, even when billing is inactive.'}
              </p>
            </div>
          </div>

          <div className="account-list">
            {overview?.devices && overview.devices.length > 0 ? (
              overview.devices.map((device) => (
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
                    style={{
                      width: '20px',
                      height: '20px',
                      objectFit: 'contain',
                      opacity: 0.45,
                    }}
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

        {privateVpmEnabled ? (
          hasPackageRegistryCapabilityError ? (
            <PackageRegistryAccessGate
              className="intg-card animate-in animate-in-delay-3 bento-col-12"
              mode="error"
              isRetrying={query.isFetching}
              onRetry={() => {
                void query.refetch();
              }}
            />
          ) : hasPackageRegistryAccess ? (
            <PackageRegistryPanel
              className="intg-card animate-in animate-in-delay-3 bento-col-12"
              description="Package identity lives beside certificates. Keep stable package IDs, rename them for humans, and reuse them across Unity projects."
            />
          ) : (
            <PackageRegistryAccessGate
              className="intg-card animate-in animate-in-delay-3 bento-col-12"
              mode="missing"
            />
          )
        ) : null}
      </div>
    </div>
  );
}
