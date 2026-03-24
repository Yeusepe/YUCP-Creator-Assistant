import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccountInlineError, AccountModal } from '@/components/account/AccountPage';
import { DashboardAuthRequiredState } from '@/components/dashboard/AuthRequiredState';
import { DashboardCertificatesSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { useToast } from '@/components/ui/Toast';
import { useActiveDashboardContext } from '@/hooks/useActiveDashboardContext';
import { isDashboardAuthError, useDashboardSession } from '@/hooks/useDashboardSession';
import {
  type CreatorCertificateDevice,
  type CreatorCertificatePlan,
  createCreatorCertificateCheckout,
  formatCertificateDate,
  getCreatorCertificatePortal,
  listCreatorCertificates,
  revokeCreatorCertificate,
} from '@/lib/certificates';

interface DashboardCertificatesSearch {
  plan?: string;
  checkout?: string;
  portal?: string;
  source?: string;
}

function DashboardCertificatesPending() {
  return (
    <div id="tab-panel-certificates" className="dashboard-tab-panel is-active" role="tabpanel">
      <div className="bento-grid">
        <DashboardCertificatesSkeleton />
      </div>
    </div>
  );
}

export const Route = createFileRoute('/dashboard/certificates')({
  validateSearch: (search: Record<string, unknown>): DashboardCertificatesSearch => ({
    plan: typeof search.plan === 'string' ? search.plan : undefined,
    checkout: typeof search.checkout === 'string' ? search.checkout : undefined,
    portal: typeof search.portal === 'string' ? search.portal : undefined,
    source: typeof search.source === 'string' ? search.source : undefined,
  }),
  pendingComponent: DashboardCertificatesPending,
  component: DashboardCertificates,
});

function formatQuota(value: number | null) {
  return value === null ? 'Unlimited' : value.toLocaleString();
}

/* ── Icons ── */

function PolarIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="none" />
      <path d="M10 8l6 4-6 4V8z" fill="currentColor" />
    </svg>
  );
}

/* ── Plan Card ── */

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
  const highlights =
    plan.highlights.length > 0
      ? plan.highlights
      : [
          `${plan.deviceCap} signing machine${plan.deviceCap !== 1 ? 's' : ''}`,
          `${formatQuota(plan.signQuotaPerPeriod)} signatures per period`,
          `${plan.auditRetentionDays}-day audit log retention`,
          `${plan.supportTier === 'premium' ? 'Premium' : 'Standard'} support`,
        ];

  return (
    <article className={`account-plan-card ${isCurrentPlan ? 'is-current' : ''}`}>
      <div className="account-plan-title-row">
        <div>
          <h3 className="account-plan-name">{plan.displayName}</h3>
          {plan.description && (
            <p className="account-plan-meta" style={{ fontFamily: 'inherit' }}>
              {plan.description}
            </p>
          )}
        </div>
        {isCurrentPlan && <span className="account-badge account-badge--connected">Active</span>}
      </div>

      <ul
        className="account-plan-feature-list"
        style={{ listStyle: 'none', paddingLeft: 0, flex: 1 }}
      >
        {highlights.map((h) => (
          <li
            key={`${plan.planKey}-${h}`}
            style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              aria-hidden="true"
              style={{
                flexShrink: 0,
                marginTop: '3px',
                color: isCurrentPlan ? '#0ea5e9' : '#94a3b8',
              }}
            >
              <circle cx="6" cy="6" r="5" fill="currentColor" opacity="0.15" />
              <path
                d="M3.5 6l1.8 1.8L8.5 4"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {h}
          </li>
        ))}
      </ul>

      <button
        type="button"
        className={`account-btn account-btn--${isCurrentPlan ? 'secondary' : 'primary'} ${isPending ? 'btn-loading' : ''}`}
        style={{ width: '100%', justifyContent: 'center', borderRadius: '999px' }}
        onClick={() => onCheckout(plan)}
        disabled={isPending || isCurrentPlan}
      >
        {isPending ? (
          <span className="btn-loading-spinner" />
        ) : isCurrentPlan ? (
          'Current Plan'
        ) : (
          <>
            <PolarIcon />
            Subscribe via Polar
          </>
        )}
      </button>
    </article>
  );
}

/* ── Device Row ── */

function CertificateDeviceRow({
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
    <div className="account-list-row">
      <div
        className="account-list-row-icon"
        style={{ background: isActive ? 'rgba(34,197,94,0.1)' : 'rgba(148,163,184,0.1)' }}
      >
        <img
          src="/Icons/Laptop.png"
          alt=""
          aria-hidden="true"
          style={{
            width: '18px',
            height: '18px',
            objectFit: 'contain',
            opacity: isActive ? 1 : 0.4,
          }}
        />
      </div>

      <div className="account-list-row-info">
        <p className="account-list-row-name">{device.publisherName}</p>
        <div className="account-list-row-meta">
          <span className="account-reference-chip">{device.devPublicKey.slice(0, 20)}…</span>
          <span
            className={`account-badge account-badge--${isActive ? 'active' : 'revoked'}`}
            style={{ textTransform: 'capitalize' }}
          >
            {device.status}
          </span>
          <span>Issued {formatCertificateDate(device.issuedAt)}</span>
          <span aria-hidden="true">·</span>
          <span>Expires {formatCertificateDate(device.expiresAt)}</span>
        </div>
      </div>

      <div className="account-list-row-actions">
        {isActive && (
          <button
            type="button"
            className="account-btn account-btn--danger"
            style={{ borderRadius: '8px', fontSize: '12px', padding: '5px 12px' }}
            onClick={() => setConfirming(true)}
          >
            Revoke
          </button>
        )}
      </div>

      {confirming && (
        <AccountModal
          title="Revoke Device"
          onClose={() => {
            if (!isRevoking) setConfirming(false);
          }}
        >
          <p className="account-modal-body">
            You are about to revoke <strong>{device.publisherName}</strong>. This takes effect
            immediately and invalidates its signing certificate.
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
              className={`account-btn account-btn--danger ${isRevoking ? 'btn-loading' : ''}`}
              onClick={() => onRevoke(device.certNonce)}
              disabled={isRevoking}
            >
              {isRevoking ? <span className="btn-loading-spinner" /> : 'Confirm Revocation'}
            </button>
          </div>
        </AccountModal>
      )}
    </div>
  );
}

/* ── Page ── */

export default function DashboardCertificates() {
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
    if (isDashboardAuthError(certificatesQuery.error)) markSessionExpired();
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
      toast.error('Could not open billing portal', {
        description: 'Session expired or portal unavailable.',
      });
    },
  });

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
      toast.error('Could not revoke device', { description: 'Contact support if this persists.' });
    },
    onSettled: () => setPendingCertNonce(null),
  });

  const overview = certificatesQuery.data;
  const billing = overview?.billing;
  const currentPlan = useMemo(
    () => overview?.availablePlans.find((p) => p.planKey === overview.billing.planKey) ?? null,
    [overview]
  );

  const isLoading = !isAuthResolved || (canRunPanelQueries && certificatesQuery.isLoading);
  const hasAuthError = isDashboardAuthError(certificatesQuery.error);
  const hasActiveSubscription =
    billing && (billing.status === 'active' || billing.status === 'grace');
  const activeDeviceCount = overview?.devices.filter((d) => d.status === 'active').length ?? 0;

  useEffect(() => {
    if (!overview || certificatesQuery.isLoading) return;
    if (search.checkout === '1' && search.plan) {
      const target = overview.availablePlans.find((p) => p.planKey === search.plan);
      if (target && autoLaunchRef.current !== `checkout:${target.planKey}`) {
        autoLaunchRef.current = `checkout:${target.planKey}`;
        setPendingPlanKey(target.planKey);
        checkoutMut.mutate(target.planKey);
      }
      return;
    }
    if (search.portal === '1' && autoLaunchRef.current !== 'portal') {
      autoLaunchRef.current = 'portal';
      portalMut.mutate();
    }
  }, [
    certificatesQuery.isLoading,
    overview,
    search.checkout,
    search.plan,
    search.portal,
    checkoutMut,
    portalMut,
  ]);

  const handleCheckout = (plan: CreatorCertificatePlan) => {
    setPendingPlanKey(plan.planKey);
    checkoutMut.mutate(plan.planKey);
  };

  const handleRevoke = (certNonce: string) => {
    setPendingCertNonce(certNonce);
    revokeMut.mutate(certNonce);
  };

  /* ── Guards ── */

  if (status === 'signed_out' || status === 'expired') {
    return (
      <div id="tab-panel-certificates" className="dashboard-tab-panel is-active" role="tabpanel">
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
                  Certificates are tied to your base creator identity. Return to your root dashboard
                  to manage them.
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

  /* ── Main ── */

  return (
    <div id="tab-panel-certificates" className="dashboard-tab-panel is-active" role="tabpanel">
      <div className="bento-grid">
        {certificatesQuery.isError && !hasAuthError && (
          <div className="bento-col-12">
            <AccountInlineError message="Failed to load certificate workspace. Please refresh." />
          </div>
        )}

        {/* ══════════════════════════════════════════
            Active subscription — 8 / 4 split
        ══════════════════════════════════════════ */}
        {hasActiveSubscription && !isLoading && (
          <>
            {/* Left: device list */}
            <section className="intg-card animate-in bento-col-8">
              <div className="intg-header">
                <div className="intg-icon">
                  <img
                    src="/Icons/Laptop.png"
                    alt=""
                    aria-hidden="true"
                    style={{ width: '22px', height: '22px', objectFit: 'contain' }}
                  />
                </div>
                <div className="intg-copy" style={{ flex: 1 }}>
                  <h2 className="intg-title">Authorized Machines</h2>
                  <p className="intg-desc">
                    Each enrolled machine holds a unique signing certificate. Revoking it takes
                    effect immediately.
                  </p>
                </div>
                <span className="account-badge account-badge--provider" style={{ flexShrink: 0 }}>
                  {activeDeviceCount} active
                </span>
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

            {/* Right: subscription sidebar */}
            <section className="intg-card animate-in animate-in-delay-1 bento-col-4">
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
                  <h2 className="intg-title">{currentPlan?.displayName ?? 'Subscription'}</h2>
                  <p className="intg-desc">
                    {billing.status === 'grace' ? 'Grace period' : 'Active'}
                  </p>
                </div>
                <span
                  className={`account-badge account-badge--${billing.status === 'active' ? 'active' : 'warning'}`}
                  style={{ flexShrink: 0 }}
                >
                  {billing.status}
                </span>
              </div>

              <dl className="account-kv-list">
                <div className="account-kv-row">
                  <dt className="account-kv-label">Devices</dt>
                  <dd className="account-kv-value">
                    {billing.activeDeviceCount} / {billing.deviceCap ?? '∞'}
                  </dd>
                </div>
                <div className="account-kv-row">
                  <dt className="account-kv-label">Enrollment</dt>
                  <dd className="account-kv-value">
                    {billing.allowEnrollment ? 'Open' : 'Closed'}
                  </dd>
                </div>
                <div className="account-kv-row">
                  <dt className="account-kv-label">Signing</dt>
                  <dd className="account-kv-value">
                    {billing.allowSigning ? 'Enabled' : 'Restricted'}
                  </dd>
                </div>
                {billing.signQuotaPerPeriod !== null && (
                  <div className="account-kv-row">
                    <dt className="account-kv-label">Quota</dt>
                    <dd className="account-kv-value">
                      {billing.signQuotaPerPeriod.toLocaleString()}
                    </dd>
                  </div>
                )}
                {(billing.graceUntil ?? billing.currentPeriodEnd) && (
                  <div className="account-kv-row">
                    <dt className="account-kv-label">
                      {billing.graceUntil ? 'Grace until' : 'Renews'}
                    </dt>
                    <dd className="account-kv-value">
                      {formatCertificateDate(billing.graceUntil ?? billing.currentPeriodEnd)}
                    </dd>
                  </div>
                )}
              </dl>

              <div
                style={{
                  marginTop: 'auto',
                  paddingTop: '16px',
                  borderTop: '1px solid rgba(148,163,184,0.18)',
                }}
              >
                <button
                  type="button"
                  className={`account-btn account-btn--secondary ${portalMut.isPending ? 'btn-loading' : ''}`}
                  style={{ width: '100%', justifyContent: 'center', borderRadius: '999px' }}
                  onClick={() => portalMut.mutate()}
                  disabled={portalMut.isPending || isLoading}
                >
                  {portalMut.isPending ? <span className="btn-loading-spinner" /> : <PolarIcon />}
                  Manage Billing
                </button>
              </div>
            </section>

            {/* Plans — full width */}
            {overview && overview.availablePlans.length > 0 && (
              <section className="intg-card animate-in animate-in-delay-2 bento-col-12">
                <div className="intg-header">
                  <div className="intg-icon">
                    <img
                      src="/Icons/BagPlus.png"
                      alt=""
                      aria-hidden="true"
                      style={{ width: '22px', height: '22px', objectFit: 'contain' }}
                    />
                  </div>
                  <div className="intg-copy" style={{ flex: 1 }}>
                    <h2 className="intg-title">Available Plans</h2>
                    <p className="intg-desc">
                      Upgrade or change your plan. Changes apply immediately via Polar checkout.
                    </p>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px',
                      color: '#94a3b8',
                      fontSize: '12px',
                      flexShrink: 0,
                    }}
                  >
                    <PolarIcon size={12} />
                    <span>Polar</span>
                  </div>
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                    gap: '16px',
                  }}
                >
                  {overview.availablePlans.map((plan) => (
                    <PlanCard
                      key={plan.planKey}
                      plan={plan}
                      isCurrentPlan={
                        billing?.planKey === plan.planKey &&
                        (billing.status === 'active' || billing.status === 'grace')
                      }
                      isPending={pendingPlanKey === plan.planKey && checkoutMut.isPending}
                      onCheckout={handleCheckout}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}

        {/* ══════════════════════════════════════════
            No subscription — focused upsell
        ══════════════════════════════════════════ */}
        {!hasActiveSubscription && !isLoading && (
          <>
            {/* Left: what you get */}
            <section className="intg-card animate-in bento-col-8">
              <div className="intg-header">
                <div className="intg-icon">
                  <img
                    src="/Icons/Shield.png"
                    alt=""
                    aria-hidden="true"
                    style={{ width: '22px', height: '22px', objectFit: 'contain' }}
                  />
                </div>
                <div className="intg-copy">
                  <h2 className="intg-title">Code Signing Certificates</h2>
                  <p className="intg-desc">
                    Cryptographically bind your packages to your creator identity.
                  </p>
                </div>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  gap: '10px',
                }}
              >
                {(
                  [
                    {
                      icon: '/Icons/Shield.png',
                      title: 'Verified identity',
                      desc: 'Packages are signed with a certificate tied to your creator profile.',
                    },
                    {
                      icon: '/Icons/Laptop.png',
                      title: 'Multi-device signing',
                      desc: 'Authorize multiple publishing machines under one account.',
                    },
                    {
                      icon: '/Icons/Key.png',
                      title: 'Instant revocation',
                      desc: 'Remove any device in one click — effective immediately.',
                    },
                    {
                      icon: '/Icons/Wrench.png',
                      title: 'Audit log',
                      desc: 'Full history of certificate issuance and signing events.',
                    },
                  ] as const
                ).map(({ icon, title, desc }) => (
                  <div key={title} className="acct-provider-card">
                    <div
                      className="acct-provider-icon"
                      style={{
                        background: 'rgba(15,23,42,0.04)',
                        border: '1px solid rgba(148,163,184,0.15)',
                      }}
                    >
                      <img src={icon} alt="" aria-hidden="true" />
                    </div>
                    <div className="acct-provider-info">
                      <p className="acct-provider-name">{title}</p>
                      <p className="acct-provider-meta">{desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Right: status + CTA */}
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
                  <h2 className="intg-title">Get Started</h2>
                  <p className="intg-desc">No active subscription</p>
                </div>
              </div>

              <dl className="account-kv-list">
                <div className="account-kv-row">
                  <dt className="account-kv-label">Status</dt>
                  <dd>
                    <span className="account-badge account-badge--provider">Inactive</span>
                  </dd>
                </div>
                <div className="account-kv-row">
                  <dt className="account-kv-label">Devices</dt>
                  <dd className="account-kv-value">0 enrolled</dd>
                </div>
                <div className="account-kv-row">
                  <dt className="account-kv-label">Signing</dt>
                  <dd className="account-kv-value">Not available</dd>
                </div>
              </dl>

              <div
                style={{
                  marginTop: 'auto',
                  paddingTop: '16px',
                  borderTop: '1px solid rgba(148,163,184,0.18)',
                }}
              >
                <p
                  style={{
                    margin: '0 0 12px',
                    fontSize: '12px',
                    color: '#64748b',
                    lineHeight: 1.5,
                  }}
                >
                  Choose a plan below to activate certificate signing for your account.
                </p>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                    fontSize: '11px',
                    color: '#94a3b8',
                  }}
                >
                  <PolarIcon size={11} />
                  <span>Billing managed by Polar</span>
                </div>
              </div>
            </section>

            {/* Plans — full width */}
            {overview && overview.availablePlans.length > 0 && (
              <section className="intg-card animate-in animate-in-delay-2 bento-col-12">
                <div className="intg-header">
                  <div className="intg-icon">
                    <img
                      src="/Icons/BagPlus.png"
                      alt=""
                      aria-hidden="true"
                      style={{ width: '22px', height: '22px', objectFit: 'contain' }}
                    />
                  </div>
                  <div className="intg-copy" style={{ flex: 1 }}>
                    <h2 className="intg-title">Choose a Plan</h2>
                    <p className="intg-desc">
                      Subscribe to unlock certificate signing. All plans include a{' '}
                      {overview.availablePlans[0]?.billingGraceDays ?? 3}-day grace period.
                    </p>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px',
                      color: '#94a3b8',
                      fontSize: '12px',
                      flexShrink: 0,
                    }}
                  >
                    <PolarIcon size={12} />
                    <span>Polar</span>
                  </div>
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                    gap: '16px',
                  }}
                >
                  {overview.availablePlans.map((plan) => (
                    <PlanCard
                      key={plan.planKey}
                      plan={plan}
                      isCurrentPlan={false}
                      isPending={pendingPlanKey === plan.planKey && checkoutMut.isPending}
                      onCheckout={handleCheckout}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}

        {/* Loading */}
        {isLoading && <DashboardCertificatesSkeleton />}
      </div>
    </div>
  );
}
