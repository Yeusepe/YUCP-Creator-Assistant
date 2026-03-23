import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import {
  AccountEmptyState,
  AccountInlineError,
  AccountModal,
  AccountPage,
  AccountSectionCard,
} from '@/components/account/AccountPage';
import { useToast } from '@/components/ui/Toast';
import {
  createUserCertificateCheckout,
  formatAccountDate,
  formatAccountDateTime,
  getUserCertificatePortal,
  listUserCertificates,
  revokeUserCertificate,
  type UserCertificateDevice,
  type UserCertificatePlan,
} from '@/lib/account';

export const Route = createFileRoute('/account/certificates')({
  component: AccountCertificates,
});

function getBillingBadgeClass(status: string) {
  switch (status) {
    case 'active':
      return 'account-badge--active';
    case 'grace':
      return 'account-badge--warning';
    case 'suspended':
      return 'account-badge--revoked';
    default:
      return 'account-badge--provider';
  }
}

function getBillingStatusLabel(status: string) {
  switch (status) {
    case 'active':
      return 'Active';
    case 'grace':
      return 'Grace period';
    case 'suspended':
      return 'Suspended';
    case 'inactive':
      return 'No plan';
    case 'unmanaged':
      return 'Unmanaged';
    default:
      return status;
  }
}

function getStatusBannerClass(status: string) {
  switch (status) {
    case 'active':
      return 'account-status-banner account-status-banner--success';
    case 'grace':
      return 'account-status-banner account-status-banner--warning';
    case 'suspended':
      return 'account-status-banner account-status-banner--danger';
    default:
      return 'account-status-banner account-status-banner--neutral';
  }
}

function formatQuota(value: number | null) {
  return value === null ? 'Unlimited' : value.toLocaleString();
}

function CertificateDeviceRow({
  device,
  isRevoking,
  onRevoke,
}: Readonly<{
  device: UserCertificateDevice;
  isRevoking: boolean;
  onRevoke: (certNonce: string) => void;
}>) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="account-list-row">
      <div className="account-list-row-icon" aria-hidden="true">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <rect x="5" y="3" width="14" height="18" rx="3" />
          <circle cx="12" cy="17" r="1" />
        </svg>
      </div>

      <div className="account-list-row-info">
        <p className="account-list-row-name">{device.publisherName}</p>
        <p className="account-list-row-meta">
          <span className="account-badge account-badge--provider">
            {formatAccountDate(device.issuedAt)}
          </span>
          <span className="account-badge account-badge--provider">
            Expires {formatAccountDate(device.expiresAt)}
          </span>
          <span className="account-reference-chip">{device.devPublicKey.slice(0, 18)}...</span>
        </p>
      </div>

      <div className="account-list-row-actions">
        <span className={`account-badge account-badge--${device.status}`}>
          {device.status.charAt(0).toUpperCase() + device.status.slice(1)}
        </span>
        <button
          type="button"
          className="account-btn account-btn--danger"
          onClick={() => setConfirming(true)}
        >
          Revoke
        </button>
      </div>

      {confirming ? (
        <AccountModal title="Revoke this signing device?" onClose={() => setConfirming(false)}>
          <p className="account-modal-body">
            This immediately blocks the certificate from signing new packages. Use this if the
            machine is compromised, retired, or should no longer publish under your identity.
          </p>
          <div className="account-modal-actions">
            <button
              type="button"
              className="account-btn account-btn--secondary"
              onClick={() => setConfirming(false)}
              disabled={isRevoking}
            >
              Cancel
            </button>
            <button
              type="button"
              className={`account-btn account-btn--danger${isRevoking ? ' btn-loading' : ''}`}
              onClick={() => onRevoke(device.certNonce)}
              disabled={isRevoking}
            >
              {isRevoking ? (
                <>
                  <span className="btn-loading-spinner" aria-hidden="true" />
                  Revoking...
                </>
              ) : (
                'Revoke device'
              )}
            </button>
          </div>
        </AccountModal>
      ) : null}
    </div>
  );
}

function AccountCertificates() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [pendingPlanKey, setPendingPlanKey] = useState<string | null>(null);
  const [pendingCertNonce, setPendingCertNonce] = useState<string | null>(null);

  const certificatesQuery = useQuery({
    queryKey: ['user-certificates'],
    queryFn: listUserCertificates,
  });

  const checkoutMut = useMutation({
    mutationFn: (planKey: string) => createUserCertificateCheckout(planKey),
    onSuccess: (result) => {
      window.location.href = result.url;
    },
    onError: () => {
      toast.error('Could not start checkout', {
        description: 'Please try again or refresh the page if the problem persists.',
      });
    },
    onSettled: () => {
      setPendingPlanKey(null);
    },
  });

  const portalMut = useMutation({
    mutationFn: () => getUserCertificatePortal(),
    onSuccess: (result) => {
      window.location.href = result.url;
    },
    onError: () => {
      toast.error('Could not open billing portal', {
        description: 'The portal is not ready for this account yet, or your session expired.',
      });
    },
  });

  const revokeMut = useMutation({
    mutationFn: (certNonce: string) => revokeUserCertificate(certNonce),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-certificates'] });
      toast.success('Signing device revoked', {
        description: 'That device can no longer sign new packages for this workspace.',
      });
    },
    onError: () => {
      toast.error('Could not revoke signing device', {
        description: 'Please try again. If the problem persists, contact support immediately.',
      });
    },
    onSettled: () => {
      setPendingCertNonce(null);
    },
  });

  const overview = certificatesQuery.data;
  const billing = overview?.billing;
  const currentPlan = useMemo(
    () =>
      overview?.availablePlans.find((plan) => plan.planKey === overview.billing.planKey) ?? null,
    [overview]
  );

  const handleCheckout = (plan: UserCertificatePlan) => {
    setPendingPlanKey(plan.planKey);
    checkoutMut.mutate(plan.planKey);
  };

  const handleRevoke = (certNonce: string) => {
    setPendingCertNonce(certNonce);
    revokeMut.mutate(certNonce);
  };

  return (
    <AccountPage>
      <AccountSectionCard
        className="bento-col-8 animate-in animate-in-delay-1"
        eyebrow="Signing workspace"
        title="Certificates and billing"
        description="Manage the subscription, device cap, and active signing certificates that protect your creator identity."
        actions={
          <div className="account-inline-actions">
            <button
              type="button"
              className={`account-btn account-btn--secondary${portalMut.isPending ? ' btn-loading' : ''}`}
              onClick={() => portalMut.mutate()}
              disabled={portalMut.isPending || certificatesQuery.isLoading}
            >
              {portalMut.isPending ? (
                <>
                  <span className="btn-loading-spinner" aria-hidden="true" />
                  Opening...
                </>
              ) : (
                'Manage billing'
              )}
            </button>
          </div>
        }
      >
        {certificatesQuery.isLoading ? (
          <div className="account-skeleton-stack">
            <div className="account-skeleton-row" />
            <div className="account-skeleton-row" style={{ width: '82%' }} />
            <div className="account-skeleton-row" style={{ width: '64%' }} />
          </div>
        ) : null}

        {certificatesQuery.isError ? (
          <AccountInlineError message="Failed to load certificate workspace. Please refresh." />
        ) : null}

        {overview && billing ? (
          <>
            <div className={getStatusBannerClass(billing.status)}>
              <div className="account-status-banner-copy">
                <span className={`account-badge ${getBillingBadgeClass(billing.status)}`}>
                  {getBillingStatusLabel(billing.status)}
                </span>
                <p className="account-feature-copy">
                  {billing.reason ??
                    'Your current subscription state controls whether new devices can enroll and whether active devices can continue signing.'}
                </p>
              </div>
            </div>

            <div className="account-stat-grid">
              <div className="account-stat-card">
                <span className="account-stat-label">Current plan</span>
                <span className="account-stat-value">
                  {currentPlan?.planKey ?? billing.planKey ?? 'No plan'}
                </span>
              </div>
              <div className="account-stat-card">
                <span className="account-stat-label">Active devices</span>
                <span className="account-stat-value">
                  {billing.activeDeviceCount}
                  {billing.deviceCap !== null ? ` / ${billing.deviceCap}` : ''}
                </span>
              </div>
              <div className="account-stat-card">
                <span className="account-stat-label">Signing quota</span>
                <span className="account-stat-value">
                  {formatQuota(billing.signQuotaPerPeriod)}
                </span>
              </div>
              <div className="account-stat-card">
                <span className="account-stat-label">Support</span>
                <span className="account-stat-value">{billing.supportTier ?? 'Standard'}</span>
              </div>
            </div>

            <div className="account-kv-list">
              <div className="account-kv-row">
                <span className="account-kv-label">Workspace</span>
                <span className="account-reference-chip">{overview.workspaceKey}</span>
              </div>
              <div className="account-kv-row">
                <span className="account-kv-label">Enrollment</span>
                <span className="account-kv-value">
                  {billing.allowEnrollment ? 'Allowed' : 'Blocked'}
                </span>
              </div>
              <div className="account-kv-row">
                <span className="account-kv-label">Signing</span>
                <span className="account-kv-value">
                  {billing.allowSigning ? 'Allowed' : 'Blocked'}
                </span>
              </div>
              <div className="account-kv-row">
                <span className="account-kv-label">Current period end</span>
                <span className="account-kv-value">
                  {formatAccountDateTime(billing.currentPeriodEnd)}
                </span>
              </div>
              <div className="account-kv-row">
                <span className="account-kv-label">Grace until</span>
                <span className="account-kv-value">
                  {formatAccountDateTime(billing.graceUntil)}
                </span>
              </div>
            </div>
          </>
        ) : null}
      </AccountSectionCard>

      <AccountSectionCard
        className="bento-col-4 animate-in animate-in-delay-2"
        eyebrow="Plans"
        title="Choose the right capacity"
        description="Checkout is workspace-scoped, so the subscription follows your creator workspace instead of a single browser session."
      >
        {certificatesQuery.isLoading ? (
          <div className="account-skeleton-stack">
            <div className="account-skeleton-row" />
            <div className="account-skeleton-row" style={{ width: '72%' }} />
          </div>
        ) : null}

        {!certificatesQuery.isLoading && overview?.availablePlans.length === 0 ? (
          <AccountEmptyState
            icon={
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M3 7h18" />
                <path d="M5 7l1.5 12h11L19 7" />
                <path d="M9 11v4M15 11v4" />
                <path d="M10 7V5a2 2 0 0 1 4 0v2" />
              </svg>
            }
            title="No plans configured"
            description="Certificate billing is not configured in this environment yet."
          />
        ) : null}

        {overview?.availablePlans.length ? (
          <div className="account-plan-grid">
            {overview.availablePlans.map((plan) => {
              const isCurrent = plan.planKey === overview.billing.planKey;
              const isPending = pendingPlanKey === plan.planKey && checkoutMut.isPending;
              return (
                <div
                  key={plan.planKey}
                  className={`account-plan-card${isCurrent ? ' is-current' : ''}`}
                >
                  <div className="account-plan-title-row">
                    <div>
                      <p className="account-plan-name">{plan.planKey}</p>
                      <p className="account-plan-meta">{plan.supportTier} support</p>
                    </div>
                    {isCurrent ? (
                      <span className="account-badge account-badge--active">Current</span>
                    ) : null}
                  </div>

                  <ul className="account-plan-feature-list">
                    <li>{plan.deviceCap} active device slots</li>
                    <li>{formatQuota(plan.signQuotaPerPeriod)} signing events per period</li>
                    <li>{plan.auditRetentionDays} days of audit retention</li>
                    <li>{plan.billingGraceDays} billing grace days</li>
                  </ul>

                  <button
                    type="button"
                    className={`account-btn account-btn--secondary${isPending ? ' btn-loading' : ''}`}
                    onClick={() => handleCheckout(plan)}
                    disabled={isPending}
                  >
                    {isPending ? (
                      <>
                        <span className="btn-loading-spinner" aria-hidden="true" />
                        Opening...
                      </>
                    ) : isCurrent ? (
                      'Update plan'
                    ) : (
                      'Choose plan'
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
      </AccountSectionCard>

      <AccountSectionCard
        className="bento-col-7 animate-in animate-in-delay-2"
        eyebrow="Signing devices"
        title="Active certificate devices"
        description="Every listed device currently holds an active signing certificate. Revoke anything you no longer trust."
      >
        {certificatesQuery.isLoading ? (
          <div className="account-skeleton-stack">
            <div className="account-skeleton-row" />
            <div className="account-skeleton-row" style={{ width: '80%' }} />
            <div className="account-skeleton-row" style={{ width: '58%' }} />
          </div>
        ) : null}

        {overview && overview.devices.length === 0 ? (
          <AccountEmptyState
            icon={
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
              >
                <rect x="5" y="3" width="14" height="18" rx="3" />
                <circle cx="12" cy="17" r="1" />
              </svg>
            }
            title="No active signing devices"
            description="Issue a certificate from the Unity tools on a trusted machine to enroll it here."
          />
        ) : null}

        {overview?.devices.map((device) => (
          <CertificateDeviceRow
            key={device.certNonce}
            device={device}
            isRevoking={pendingCertNonce === device.certNonce && revokeMut.isPending}
            onRevoke={handleRevoke}
          />
        ))}
      </AccountSectionCard>

      <AccountSectionCard
        className="bento-col-5 animate-in animate-in-delay-3"
        eyebrow="Policy"
        title="How continuity works"
        description="The billing layer and the certificate security layer stay separate so you can recover safely without opening abuse paths."
      >
        <div className="account-note-stack">
          <p className="account-feature-copy">
            Existing devices can keep signing during billing grace, but new-device enrollment is
            blocked. That keeps honest creators working while limiting subscription abuse.
          </p>
          <p className="account-feature-copy">
            Revoking a device is always a security action, not a billing action. If a machine is no
            longer trusted, revoke it immediately and reissue on a clean device.
          </p>
          <p className="account-feature-copy">
            Same-device renewals reuse the existing identity and do not consume extra device slots
            during overlap windows.
          </p>
        </div>
      </AccountSectionCard>
    </AccountPage>
  );
}
