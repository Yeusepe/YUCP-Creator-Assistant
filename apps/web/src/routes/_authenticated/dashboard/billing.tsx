import { PolarEmbedCheckout } from '@polar-sh/checkout/embed';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { AccountInlineError } from '@/components/account/AccountPage';
import { DashboardAuthRequiredState } from '@/components/dashboard/AuthRequiredState';
import {
  buildBillingStatusCopy,
  formatCapabilityLabel,
  formatMeterUnits,
  formatQuota,
} from '@/components/dashboard/CertificateWorkspacePanels';
import { DashboardCertificatesSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { useToast } from '@/components/ui/Toast';
import { useActiveDashboardContext } from '@/hooks/useActiveDashboardContext';
import { useCreatorCertificateWorkspace } from '@/hooks/useCreatorCertificateWorkspace';
import { isDashboardAuthError } from '@/hooks/useDashboardSession';
import {
  type CreatorCertificatePlan,
  createCreatorCertificateCheckout,
  formatCertificateDate,
  getCreatorCertificatePortal,
  reconcileCreatorCertificateBilling,
} from '@/lib/certificates';

interface DashboardBillingSearch {
  plan?: string;
  checkout?: string;
  portal?: string;
  source?: string;
}

function DashboardBillingPending() {
  return (
    <div id="tab-panel-billing" className="dashboard-tab-panel is-active" role="tabpanel">
      <div className="bento-grid">
        <DashboardCertificatesSkeleton />
      </div>
    </div>
  );
}

export const Route = createFileRoute('/_authenticated/dashboard/billing')({
  validateSearch: (search: Record<string, unknown>): DashboardBillingSearch => ({
    plan: typeof search.plan === 'string' ? search.plan : undefined,
    checkout: typeof search.checkout === 'string' ? search.checkout : undefined,
    portal: typeof search.portal === 'string' ? search.portal : undefined,
    source: typeof search.source === 'string' ? search.source : undefined,
  }),
  pendingComponent: DashboardBillingPending,
  component: DashboardBilling,
});

export default function DashboardBilling() {
  const search = Route.useSearch();
  const queryClient = useQueryClient();
  const toast = useToast();
  const autoLaunchRef = useRef<string | null>(null);
  const embedCheckoutRef = useRef<PolarEmbedCheckout | null>(null);

  const [pendingProductId, setPendingProductId] = useState<string | null>(null);
  const [confirmedProductId, setConfirmedProductId] = useState<string | null>(null);
  const [checkoutInProgress, setCheckoutInProgress] = useState(false);

  const { isPersonalDashboard } = useActiveDashboardContext();
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

  useEffect(() => {
    return () => {
      embedCheckoutRef.current?.close();
      embedCheckoutRef.current = null;
    };
  }, []);

  const clearCheckoutState = () => {
    embedCheckoutRef.current = null;
    setCheckoutInProgress(false);
    setPendingProductId(null);
    setConfirmedProductId(null);
  };

  const checkoutMut = useMutation({
    mutationFn: (plan: CreatorCertificatePlan) =>
      createCreatorCertificateCheckout({
        productId: plan.productId,
        planKey: plan.planKey,
      }),
    onSuccess: async (result) => {
      try {
        setCheckoutInProgress(true);
        if (embedCheckoutRef.current) {
          const activeCheckout = embedCheckoutRef.current;
          embedCheckoutRef.current = null;
          await activeCheckout.close();
        }

        const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
        const checkout = await PolarEmbedCheckout.create(result.url, { theme });
        embedCheckoutRef.current = checkout;

        checkout.addEventListener(
          'loaded',
          () => {
            toast.info('Polar checkout is ready');
          },
          { once: true }
        );

        checkout.addEventListener(
          'confirmed',
          () => {
            setConfirmedProductId(result.productId);
            toast.info('Checkout confirmed. Waiting for Polar to finalize access.');
          },
          { once: true }
        );

        checkout.addEventListener(
          'close',
          () => {
            if (embedCheckoutRef.current === checkout) {
              clearCheckoutState();
            }
          },
          { once: true }
        );

        checkout.addEventListener(
          'success',
          () => {
            void (async () => {
              try {
                const refreshed = await reconcileCreatorCertificateBilling();
                queryClient.setQueryData(['creator-certificates'], refreshed.overview);
                await queryClient.invalidateQueries({ queryKey: ['creator-certificates'] });
                toast.success('Billing updated');
              } catch (error) {
                if (isDashboardAuthError(error)) {
                  markSessionExpired();
                  return;
                }

                toast.error('Billing updated, but refresh is still pending', {
                  description: 'Your access should appear after the next webhook sync.',
                });
              } finally {
                await checkout.close();
                if (embedCheckoutRef.current === checkout) {
                  clearCheckoutState();
                }
              }
            })();
          },
          { once: true }
        );
      } catch {
        window.location.href = result.url;
        clearCheckoutState();
      }
    },
    onError: (error) => {
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }

      toast.error('Could not start checkout', {
        description: 'Please try again.',
      });
      clearCheckoutState();
    },
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

  useEffect(() => {
    if (!overview || query.isLoading) {
      return;
    }

    if (search.checkout === '1' && search.plan) {
      const target =
        overview.availablePlans.find(
          (plan) => plan.productId === search.plan || plan.planKey === search.plan
        ) ?? null;
      if (target && autoLaunchRef.current !== `checkout:${target.productId}`) {
        autoLaunchRef.current = `checkout:${target.productId}`;
        setPendingProductId(target.productId);
        checkoutMut.mutate(target);
      }
      return;
    }

    if (search.portal === '1' && autoLaunchRef.current !== 'portal') {
      autoLaunchRef.current = 'portal';
      portalMut.mutate();
    }
  }, [
    checkoutMut,
    overview,
    portalMut,
    query.isLoading,
    search.checkout,
    search.plan,
    search.portal,
  ]);

  const handleCheckout = (plan: CreatorCertificatePlan) => {
    if (checkoutMut.isPending || checkoutInProgress) {
      return;
    }

    setPendingProductId(plan.productId);
    checkoutMut.mutate(plan);
  };

  const statusCopy = buildBillingStatusCopy(billing);
  const hasPolarAccess = billing?.status === 'active' || billing?.status === 'grace';
  const hasPlans = (overview?.availablePlans.length ?? 0) > 0;
  const isCheckoutBusy = checkoutMut.isPending || checkoutInProgress;
  const activeCapabilityLabels =
    billing?.capabilities
      .filter((capability) => capability.status === 'active' || capability.status === 'grace')
      .map((capability) => formatCapabilityLabel(capability.capabilityKey)) ?? [];

  const statusVariant =
    statusCopy.badgeClass === 'active'
      ? 'active'
      : statusCopy.badgeClass === 'warning'
        ? 'warning'
        : 'inactive';

  const hasStatusStrip =
    !!statusCopy.badgeLabel || !!currentPlan?.displayName || !!billing?.currentPeriodEnd;

  if (status === 'signed_out' || status === 'expired') {
    return (
      <div id="tab-panel-billing" className="dashboard-tab-panel is-active" role="tabpanel">
        <DashboardAuthRequiredState
          id="billing-auth"
          title="Sign in to manage billing"
          description="Your session expired. Reconnect to inspect plans, checkout, or access the Polar portal."
        />
      </div>
    );
  }

  if (!isPersonalDashboard) {
    return (
      <div id="tab-panel-billing" className="dashboard-tab-panel is-active" role="tabpanel">
        <div className="bento-grid">
          <section className="intg-card animate-in bento-col-12">
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
                <h1 className="intg-title">Creator scope required</h1>
                <p className="intg-desc">
                  Polar billing is attached to your creator identity. Return to your root dashboard
                  to manage plans and checkout.
                </p>
              </div>
            </div>
            <Link
              to="/dashboard/billing"
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
      <div id="tab-panel-billing" className="dashboard-tab-panel is-active" role="tabpanel">
        <div className="bento-grid">
          <DashboardCertificatesSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div id="tab-panel-billing" className="dashboard-tab-panel is-active" role="tabpanel">
      <div className="bento-grid">
        {query.isError && !hasAuthError && (
          <div className="bento-col-12">
            <AccountInlineError message="Failed to load billing. Please refresh." />
          </div>
        )}

        {/* ── Page header ── */}
        <section className="billing-page-header bento-col-12">
          <div className="billing-page-header-top">
            <div className="billing-page-header-main">
              <div>
                <h1 className="billing-page-title">Plans &amp; Billing</h1>
                <p className="billing-page-subtitle">
                  {hasPolarAccess
                    ? 'Manage your active Polar subscription, inspect entitlements, and access invoices.'
                    : 'Subscribe to Creator Suite via Polar to unlock exports, certificate signing, and more.'}
                </p>
              </div>
            </div>

            <div className="billing-page-header-actions">
              <Link
                to="/dashboard/certificates"
                search={(prev) => ({ ...prev, guild_id: undefined, tenant_id: undefined })}
                className="account-btn account-btn--secondary"
                style={{ borderRadius: '10px', fontSize: '13px' }}
              >
                Certificates
              </Link>
              <button
                type="button"
                className={`account-btn account-btn--primary${portalMut.isPending ? ' btn-loading' : ''}`}
                style={{ borderRadius: '10px', fontSize: '13px' }}
                onClick={() => portalMut.mutate()}
                disabled={portalMut.isPending}
              >
                {portalMut.isPending ? (
                  <span className="btn-loading-spinner" aria-hidden="true" />
                ) : (
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                )}
                {portalMut.isPending ? 'Opening…' : 'Polar Portal'}
              </button>
            </div>
          </div>

          {hasStatusStrip && (
            <div className="billing-status-strip">
              {statusCopy.badgeLabel && (
                <span
                  className={`billing-status-indicator billing-status-indicator--${statusVariant}`}
                >
                  <span
                    className={`billing-status-dot${statusVariant === 'active' ? ' billing-status-dot--pulse' : ''}`}
                  />
                  {statusCopy.badgeLabel}
                </span>
              )}
              {(currentPlan?.displayName ?? currentPlan?.displayBadge) && (
                <>
                  <span className="billing-status-sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="billing-status-plan-name">
                    {currentPlan?.displayName ?? currentPlan?.displayBadge}
                  </span>
                </>
              )}
              {billing?.currentPeriodEnd && (
                <>
                  <span className="billing-status-sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="billing-status-renewal">
                    Renews {formatCertificateDate(billing.currentPeriodEnd)}
                  </span>
                </>
              )}
            </div>
          )}
        </section>

        {/* ── Current Access ── */}
        {hasPolarAccess && (
          <section className="billing-panel bento-col-7">
            <div className="billing-panel-header">
              <div className="billing-panel-icon">
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
                >
                  <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                </svg>
              </div>
              <div>
                <h2 className="billing-panel-title">Current Access</h2>
                <p className="billing-panel-desc">
                  Real-time limits and usage from your active Polar subscription.
                </p>
              </div>
            </div>

            <div className="billing-stats-grid">
              <article className="billing-stat-tile">
                <span className="billing-stat-label">Sign Quota</span>
                <strong className="billing-stat-value">
                  {formatQuota(billing?.signQuotaPerPeriod ?? null)}
                </strong>
                <span className="billing-stat-sub">per billing period</span>
              </article>

              <article className="billing-stat-tile">
                <span className="billing-stat-label">Active Devices</span>
                <strong className="billing-stat-value">
                  {billing?.activeDeviceCount ?? 0}
                  {billing?.deviceCap ? (
                    <span className="billing-stat-value-sub"> / {billing.deviceCap}</span>
                  ) : null}
                </strong>
                {billing?.deviceCap && billing.deviceCap > 0 && (
                  <div className="billing-meter" role="progressbar">
                    <div
                      className={`billing-meter-fill${(billing.activeDeviceCount / billing.deviceCap) > 0.85 ? ' billing-meter-fill--warning' : ''}`}
                      style={{
                        width: `${Math.min(100, (billing.activeDeviceCount / billing.deviceCap) * 100).toFixed(1)}%`,
                      }}
                    />
                  </div>
                )}
              </article>

              {activeCapabilityLabels.length > 0 && (
                <article className="billing-stat-tile">
                  <span className="billing-stat-label">Capabilities</span>
                  <strong className="billing-stat-value">{activeCapabilityLabels.length}</strong>
                  <div className="billing-stat-chips">
                    {activeCapabilityLabels.map((label) => (
                      <span key={label} className="billing-stat-chip">
                        {label}
                      </span>
                    ))}
                  </div>
                </article>
              )}

              {!!billing?.auditRetentionDays && (
                <article className="billing-stat-tile">
                  <span className="billing-stat-label">Audit Retention</span>
                  <strong className="billing-stat-value">{billing.auditRetentionDays}</strong>
                  <span className="billing-stat-sub">days</span>
                </article>
              )}

              {(overview?.meters ?? []).map((meter) => {
                const total = meter.consumedUnits + meter.balance;
                const pct = total > 0 ? (meter.consumedUnits / total) * 100 : 0;
                return (
                  <article key={meter.meterId} className="billing-stat-tile">
                    <span className="billing-stat-label">{meter.meterName ?? meter.meterId}</span>
                    <strong className="billing-stat-value">
                      {formatMeterUnits(meter.consumedUnits)}
                    </strong>
                    <span className="billing-stat-sub">
                      {meter.balance > 0
                        ? `${formatMeterUnits(meter.balance)} remaining`
                        : `${formatMeterUnits(meter.creditedUnits)} credited`}
                    </span>
                    {total > 0 && (
                      <div className="billing-meter" role="progressbar">
                        <div
                          className={`billing-meter-fill${pct > 85 ? ' billing-meter-fill--warning' : ''}`}
                          style={{ width: `${pct.toFixed(1)}%` }}
                        />
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {/* ── Feature Showcase ── */}
        <section
          className={`billing-panel billing-animate-${hasPolarAccess ? '3' : '2'} ${hasPolarAccess ? 'bento-col-5' : 'bento-col-12'}`}
        >
          <div className="billing-panel-header">
            <div className="billing-panel-icon">
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
              >
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            </div>
            <div>
              <h2 className="billing-panel-title">What Suite+ Unlocks</h2>
              <p className="billing-panel-desc">
                Polar benefit grants drive these features, not hardcoded plan JSON.
              </p>
            </div>
          </div>

          <div className="billing-features-grid">
            {(
              [
                {
                  icon: '/Icons/Shield.png',
                  title: 'Protected exports',
                  desc: 'Gate high-trust releases behind Polar-backed access instead of local plan JSON.',
                },
                {
                  icon: '/Icons/Wrench.png',
                  title: 'Coupling traceability',
                  desc: 'Unlock forensics and package lineage when the Polar benefit grant is active.',
                },
                {
                  icon: '/Icons/Key.png',
                  title: 'Moderation lookup',
                  desc: 'Expose trust and moderation tooling from the same active Suite subscription.',
                },
                {
                  icon: '/Icons/Laptop.png',
                  title: 'Certificate operations',
                  desc: 'Keep machine enrollment, revocation, and signing separate from commerce.',
                },
              ] as const
            ).map(({ icon, title, desc }) => (
              <div key={title} className="billing-feature-card">
                <div className="billing-feature-icon-wrap">
                  <img
                    src={icon}
                    alt=""
                    aria-hidden="true"
                    width="18"
                    height="18"
                    style={{ objectFit: 'contain' }}
                  />
                </div>
                <div>
                  <p className="billing-feature-title">{title}</p>
                  <p className="billing-feature-desc">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── Plans from Polar ── */}
        <section className={`billing-animate-${hasPolarAccess ? '4' : '3'} bento-col-12`}>
          <div className="billing-plans-section-header">
            <h2 className="billing-plans-title">Plans from Polar</h2>
            <p className="billing-plans-desc">
              Live product names, descriptions, and pricing rendered from the Polar catalog.
            </p>
          </div>

          {hasPlans ? (
            <div className="billing-plans-grid">
              {overview?.availablePlans.map((plan) => {
                const isActive =
                  hasPolarAccess &&
                  (billing?.productId === plan.productId || billing?.planKey === plan.planKey);
                const isPendingAction =
                  (pendingProductId === plan.productId || confirmedProductId === plan.productId) &&
                  isCheckoutBusy;

                return (
                  <article
                    key={plan.planKey}
                    className={`billing-plan-card ${isActive ? 'is-active' : ''}`}
                  >
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                      <div className="billing-plan-header-row">
                        <h3 className="billing-plan-name">{plan.displayName}</h3>
                        {isActive && <span className="billing-current-badge">Current</span>}
                      </div>

                      {plan.displayBadge && (
                        <span className="billing-plan-tier-badge">{plan.displayBadge}</span>
                      )}

                      {plan.description && <p className="billing-plan-desc">{plan.description}</p>}

                      <div className="billing-plan-divider" />

                      <ul className="billing-plan-features">
                        {plan.highlights.map((feat) => (
                          <li key={`${plan.planKey}-${feat}`} className="billing-plan-feature">
                            <span className="billing-plan-check" aria-hidden="true">
                              <svg
                                width="9"
                                height="9"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="3.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <title>Included</title>
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            </span>
                            <span>{feat}</span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <button
                      type="button"
                      className={`billing-plan-cta ${isActive ? 'billing-plan-cta--active' : 'billing-plan-cta--subscribe'}${isPendingAction ? ' btn-loading' : ''}`}
                      onClick={() => handleCheckout(plan)}
                      disabled={isCheckoutBusy || isActive}
                    >
                      {isPendingAction ? (
                        <span className="btn-loading-spinner" aria-hidden="true" />
                      ) : isActive ? (
                        'Current Plan'
                      ) : (
                        <>
                          <img
                            src="/Icons/Polar.svg"
                            alt=""
                            aria-hidden="true"
                            width="14"
                            height="14"
                          />
                          Subscribe via Polar
                        </>
                      )}
                    </button>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="billing-empty">
              <div className="billing-empty-icon">
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
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <h3 className="billing-empty-title">No published plans yet</h3>
              <p className="billing-empty-desc">
                Publish a recurring Polar product with entitlement benefits and it will appear here
                automatically.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
