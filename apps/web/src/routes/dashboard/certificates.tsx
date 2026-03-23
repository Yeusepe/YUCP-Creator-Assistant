import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccountInlineError, AccountModal } from '@/components/account/AccountPage';
import { DashboardAuthRequiredState } from '@/components/dashboard/AuthRequiredState';
import { useToast } from '@/components/ui/Toast';
import { useActiveDashboardContext } from '@/hooks/useActiveDashboardContext';
import { isDashboardAuthError, useDashboardSession } from '@/hooks/useDashboardSession';
import {
  type CreatorCertificateDevice,
  type CreatorCertificatePlan,
  createCreatorCertificateCheckout,
  formatCertificateDate,
  formatCertificateDateTime,
  getCreatorCertificatePortal,
  listCreatorCertificates,
  revokeCreatorCertificate,
} from '@/lib/certificates';

import '@/styles/certificates.css';

interface DashboardCertificatesSearch {
  plan?: string;
  checkout?: string;
  portal?: string;
  source?: string;
}

export const Route = createFileRoute('/dashboard/certificates')({
  validateSearch: (search: Record<string, unknown>): DashboardCertificatesSearch => ({
    plan: typeof search.plan === 'string' ? search.plan : undefined,
    checkout: typeof search.checkout === 'string' ? search.checkout : undefined,
    portal: typeof search.portal === 'string' ? search.portal : undefined,
    source: typeof search.source === 'string' ? search.source : undefined,
  }),
  component: DashboardCertificates,
});

/* Utilities */
function formatQuota(value: number | null) {
  return value === null ? 'Unlimited' : value.toLocaleString();
}

function getBillingStatusLabel(status: string) {
  switch (status) {
    case 'active':
      return 'Active Subscription';
    case 'grace':
      return 'Grace Period';
    case 'suspended':
      return 'Suspended';
    case 'inactive':
    case 'unmanaged':
      return 'No Plan';
    default:
      return status;
  }
}

/* Icons */
function PolarIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="rgba(255,255,255,0.1)" />
      <path d="M10 8l6 4-6 4V8z" fill="currentColor" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function DeviceIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="2" width="16" height="20" rx="2" ry="2" />
      <line x1="12" y1="18" x2="12.01" y2="18" />
    </svg>
  );
}

/* Plan Card Component */
function PlanCard({
  plan,
  isCurrentPlan,
  isPending,
  onCheckout,
}: Readonly<{
  plan: CreatorCertificatePlan;
  isCurrentPlan: boolean;
  isPending: boolean;
  onCheckout: (plan: CreatorCertificatePlan) => void;
}>) {
  const highlights = plan.highlights.length > 0 ? plan.highlights : [
    `${plan.deviceCap} signing ${plan.deviceCap === 1 ? 'device' : 'devices'}`,
    `${formatQuota(plan.signQuotaPerPeriod)} signatures / period`,
    `${plan.auditRetentionDays} day audit retention`,
    `${plan.supportTier} support`
  ];

  return (
    <article className={`cert-plan-wrap ${isCurrentPlan ? 'is-current' : ''}`}>
      {isCurrentPlan && <div className="cert-plan-current-badge">Current Plan</div>}
      
      <div className="cert-plan-header">
        <h3 className="cert-plan-name">{plan.displayName}</h3>
        {plan.description && <p className="cert-plan-desc">{plan.description}</p>}
      </div>

      <ul className="cert-plan-features">
        {highlights.map((h, i) => (
          <li key={`${plan.planKey}-${i}`} className="cert-plan-feature-item">
            <div className="cert-plan-feature-icon">
              <CheckIcon />
            </div>
            {h}
          </li>
        ))}
      </ul>

      <button
        type="button"
        className={`cert-plan-btn ${isPending ? 'is-loading' : ''} ${isCurrentPlan ? 'secondary' : ''}`}
        onClick={() => onCheckout(plan)}
        disabled={isPending || isCurrentPlan}
      >
        {isPending ? (
          <span className="cert-spinner" />
        ) : isCurrentPlan ? (
          'Current Workspace Plan'
        ) : (
          'Select via Polar'
        )}
      </button>
    </article>
  );
}

/* Active Devices Table Row */
function DeviceTableRow({
  device,
  isRevoking,
  onRevoke,
}: Readonly<{
  device: CreatorCertificateDevice;
  isRevoking: boolean;
  onRevoke: (certNonce: string) => void;
}>) {
  const [confirming, setConfirming] = useState(false);
  const isActive = device.status === 'active';

  return (
    <>
      <tr>
        <td>
          <div style={{ fontWeight: 700, marginBottom: '4px', color: 'inherit' }}>{device.publisherName}</div>
          <div style={{ fontSize: '12px', color: '#64748b', fontFamily: 'monospace' }}>{device.devPublicKey.slice(0, 16)}...</div>
        </td>
        <td>
          <div className="cert-badge cert-badge-active">
            <span className="cert-badge-pulse" />
            {device.status.toUpperCase()}
          </div>
        </td>
        <td>{formatCertificateDate(device.issuedAt)}</td>
        <td style={{ textAlign: 'right' }}>
          {isActive && (
            <button className="cert-btn-revoke" onClick={() => setConfirming(true)}>
              Revoke
            </button>
          )}
        </td>
      </tr>

      {confirming && (
        <AccountModal title="Revoke this device?" onClose={() => setConfirming(false)}>
          <p className="account-modal-body">
            This immediately blocks the certificate from signing new packages. Are you sure you want to proceed?
          </p>
          <div className="account-modal-actions">
            <button className="account-btn account-btn--secondary" onClick={() => setConfirming(false)} disabled={isRevoking}>
              Cancel
            </button>
            <button className={`account-btn account-btn--danger ${isRevoking ? 'btn-loading' : ''}`} onClick={() => {
              onRevoke(device.certNonce);
              setConfirming(false);
            }} disabled={isRevoking}>
              {isRevoking ? <span className="btn-loading-spinner" /> : 'Confirm Revocation'}
            </button>
          </div>
        </AccountModal>
      )}
    </>
  );
}

/* Main Dashboard Page */
function DashboardCertificates() {
  const search = Route.useSearch();
  const queryClient = useQueryClient();
  const toast = useToast();
  const autoLaunchRef = useRef<string | null>(null);
  const [pendingPlanKey, setPendingPlanKey] = useState<string | null>(null);
  const [pendingCertNonce, setPendingCertNonce] = useState<string | null>(null);
  const { isPersonalDashboard } = useActiveDashboardContext();
  const { canRunPanelQueries, isAuthResolved, markSessionExpired, status } = useDashboardSession();

  const certificatesQuery = useQuery({
    queryKey: ['creator-certificates'],
    queryFn: listCreatorCertificates,
    enabled: canRunPanelQueries,
  });

  useEffect(() => {
    if (isDashboardAuthError(certificatesQuery.error)) {
      markSessionExpired();
    }
  }, [certificatesQuery.error, markSessionExpired]);

  const checkoutMut = useMutation({
    mutationFn: (planKey: string) => createCreatorCertificateCheckout(planKey),
    onSuccess: (result) => {
      window.location.href = result.url;
    },
    onError: (error) => {
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      toast.error('Could not start checkout', { description: 'Please try again.' });
    },
    onSettled: () => setPendingPlanKey(null),
  });

  const portalMut = useMutation({
    mutationFn: () => getCreatorCertificatePortal(),
    onSuccess: (result) => {
      window.location.href = result.url;
    },
    onError: (error) => {
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      toast.error('Could not open billing portal', { description: 'Session expired or portal unavailable.' });
    },
  });

  const revokeMut = useMutation({
    mutationFn: (certNonce: string) => revokeCreatorCertificate(certNonce),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['creator-certificates'] });
      toast.success('Device revoked successfully');
    },
    onError: (error) => {
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      toast.error('Could not revoke device', { description: 'Contact support if this persists.' });
    },
    onSettled: () => setPendingCertNonce(null),
  });

  const overview = certificatesQuery.data;
  const billing = overview?.billing;
  const currentPlan = useMemo(
    () => overview?.availablePlans.find((plan) => plan.planKey === overview.billing.planKey) ?? null,
    [overview]
  );
  const isLoading = !isAuthResolved || (canRunPanelQueries && certificatesQuery.isLoading);
  const hasAuthError = isDashboardAuthError(certificatesQuery.error);

  useEffect(() => {
    if (!overview || certificatesQuery.isLoading) return;

    if (search.checkout === '1' && search.plan) {
      const targetPlan = overview.availablePlans.find((plan) => plan.planKey === search.plan);
      if (targetPlan && autoLaunchRef.current !== `checkout:${targetPlan.planKey}`) {
        autoLaunchRef.current = `checkout:${targetPlan.planKey}`;
        setPendingPlanKey(targetPlan.planKey);
        checkoutMut.mutate(targetPlan.planKey);
      }
      return;
    }

    if (search.portal === '1' && autoLaunchRef.current !== 'portal') {
      autoLaunchRef.current = 'portal';
      portalMut.mutate();
    }
  }, [certificatesQuery.isLoading, overview, search.checkout, search.plan, search.portal, checkoutMut, portalMut]);

  const handleCheckout = (plan: CreatorCertificatePlan) => {
    setPendingPlanKey(plan.planKey);
    checkoutMut.mutate(plan.planKey);
  };

  const handleRevoke = (certNonce: string) => {
    setPendingCertNonce(certNonce);
    revokeMut.mutate(certNonce);
  };

  if (status === 'signed_out' || status === 'expired') {
    return (
      <div className="cert-dashboard-wrapper">
        <DashboardAuthRequiredState
          id="cert-auth"
          title="Sign in to manage certificates"
          description="Your session expired. Connect to access billing and devices."
        />
      </div>
    );
  }

  if (!isPersonalDashboard) {
    return (
      <div className="cert-dashboard-wrapper">
        <div className="cert-hero" style={{ flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left', padding: '60px' }}>
          <h1 className="cert-hero-title">Creator Scope Required</h1>
          <p className="cert-hero-desc" style={{ marginBottom: '32px' }}>
            Certificates are tied to your base creator identity. Please return to your root dashboard to manage them.
          </p>
          <Link
            to="/dashboard/certificates"
            search={(prev) => ({ ...prev, guild_id: undefined, tenant_id: undefined })}
            className="cert-polar-btn"
          >
            Switch to Creator Dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="cert-dashboard-wrapper animate-in fade-in duration-500">
      
      {/* ── Premium Hero ── */}
      <section className="cert-hero">
        <div className="cert-hero-content">
          <div className="cert-hero-eyebrow">
            <span className="cert-hero-eyebrow-dot" /> High-Assurance Workspace
          </div>
          <h1 className="cert-hero-title">Certificate Security</h1>
          <p className="cert-hero-desc">
            Secure, scalable, and isolated signing access powered by our integrated Polar enterprise tier. Manage metrics and machines effortlessly.
          </p>
        </div>
        <div className="cert-hero-actions">
          <button
            className={`cert-polar-btn ${portalMut.isPending ? 'is-loading' : ''}`}
            onClick={() => portalMut.mutate()}
            disabled={portalMut.isPending || isLoading}
          >
            {portalMut.isPending ? <span className="cert-spinner" /> : <PolarIcon />}
            Manage Billing on Polar
          </button>
        </div>
      </section>

      {/* ── Errors / Loaders ── */}
      {certificatesQuery.isError && !hasAuthError && (
        <AccountInlineError message="Failed to load workspace. Please refresh." />
      )}

      {/* ── Mission Control Stats ── */}
      {billing && (
        <section>
          <h2 className="cert-section-title">Workspace Telemetry</h2>
          <div className="cert-stats-grid">
            <div className="cert-stat-card">
              <span className="cert-stat-label">Device Quota</span>
              <span className="cert-stat-value">
                {billing.activeDeviceCount} <span style={{fontSize: '16px', color: '#94a3b8'}}>/ {billing.deviceCap ?? '∞'}</span>
              </span>
              <span className="cert-stat-desc">Provisioned Signers</span>
            </div>
            <div className="cert-stat-card">
              <span className="cert-stat-label">Status</span>
              <span className="cert-stat-value" style={{ color: billing.status === 'active' ? '#0ea5e9' : '#f59e0b' }}>
                {getBillingStatusLabel(billing.status)}
              </span>
              <span className="cert-stat-desc">{currentPlan?.displayName ?? 'Tier'}</span>
            </div>
            <div className="cert-stat-card">
              <span className="cert-stat-label">Enrollment Pipeline</span>
              <span className="cert-stat-value" style={{ fontSize: '24px', paddingTop: '10px' }}>
                {billing.allowEnrollment ? 'Accepting Signers' : 'Restricted'}
              </span>
              <span className="cert-stat-desc">Zero Trust Security</span>
            </div>
            <div className="cert-stat-card">
              <span className="cert-stat-label">{billing.graceUntil ? 'Grace Until' : 'Renews On'}</span>
              <span className="cert-stat-value" style={{ fontSize: '24px', paddingTop: '10px' }}>
                {billing.graceUntil
                  ? formatCertificateDate(billing.graceUntil)
                  : formatCertificateDate(billing.currentPeriodEnd ?? null)}
              </span>
              <span className="cert-stat-desc">Sourced from Polar</span>
            </div>
          </div>
        </section>
      )}

      {/* ── Subscriptions ── */}
      <section>
        <h2 className="cert-section-title">Polar Subscriptions</h2>
        {isLoading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#64748b' }}>Refreshing Tiers...</div>
        ) : (
          <div className="cert-pricing-grid">
            {(overview?.availablePlans ?? []).map((plan) => (
              <PlanCard
                key={plan.planKey}
                plan={plan}
                isCurrentPlan={billing?.planKey === plan.planKey && billing.status === 'active'}
                isPending={pendingPlanKey === plan.planKey && checkoutMut.isPending}
                onCheckout={handleCheckout}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Authorized Devices Table ── */}
      <section>
        <h2 className="cert-section-title">Deployments & Auth</h2>
        
        {overview?.devices && overview.devices.length > 0 ? (
          <div className="cert-devices-table-wrap">
            <table className="cert-devices-table">
              <thead>
                <tr>
                  <th>Machine Identifier</th>
                  <th>State</th>
                  <th>Issued</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {overview.devices.map((device) => (
                  <DeviceTableRow
                    key={device.certNonce}
                    device={device}
                    isRevoking={pendingCertNonce === device.certNonce && revokeMut.isPending}
                    onRevoke={handleRevoke}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : !isLoading ? (
           <div className="cert-devices-table-wrap cert-empty-state">
             <div style={{ color: '#94a3b8', marginBottom: '20px' }}><DeviceIcon /></div>
             <h3>No Active Signers</h3>
             <p>Once you connect from Unity and acquire a certificate, your device fingerprint will be permanently tracked here.</p>
           </div>
        ) : null}
      </section>
      
    </div>
  );
}
