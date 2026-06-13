import { PolarEmbedCheckout } from '@polar-sh/checkout/embed';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createLazyFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { AccountInlineError } from '@/components/account/AccountPage';
import { DashboardAuthRequiredState } from '@/components/dashboard/AuthRequiredState';
import {
  buildBillingStatusCopy,
  formatCapabilityLabel,
  formatMeterUnits,
  formatQuota,
} from '@/components/dashboard/CertificateWorkspacePanels';
import { DashboardBillingSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { useToast } from '@/components/ui/Toast';
import { YucpButton } from '@/components/ui/YucpButton';
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

function DashboardBillingPending() {
  return (
    <div id="tab-panel-billing" className="dashboard-tab-panel is-active" role="tabpanel">
      <div className="bento-grid">
        <DashboardBillingSkeleton />
      </div>
    </div>
  );
}

export const Route = createLazyFileRoute('/_authenticated/dashboard/billing')({
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
                  Polar billing is attached to your Creator Identity. Return to your root dashboard
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
          <DashboardBillingSkeleton />
        </div>
      </div>
    );
  }

  const plansSection = (
    <section className="billing-plans-section">
      <div className="billing-plans-hd">
        <p className="billing-eyebrow">Polar Catalog</p>
        <h2 className="billing-section-h2">
          {hasPolarAccess ? 'Available Plans' : 'Choose a Plan'}
        </h2>
        <p className="billing-section-sub">
          {hasPolarAccess
            ? 'Upgrade, downgrade, or compare plans at any time.'
            : 'Live pricing from Polar, subscribe once, benefit everywhere.'}
        </p>
      </div>

      {hasPlans ? (
        <div className="billing-plans-grid-v2">
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
                className={`billing-plan-card-v2${isActive ? ' is-active' : ''}`}
              >
                <div className="billing-plan-card-body">
                  <div className="billing-plan-card-top-row">
                    <h3 className="billing-plan-name-v2">{plan.displayName}</h3>
                    {isActive && <span className="billing-current-badge-v2">Current</span>}
                  </div>

                  {plan.displayBadge && (
                    <span className="billing-plan-badge-v2">{plan.displayBadge}</span>
                  )}

                  {plan.description && <p className="billing-plan-desc-v2">{plan.description}</p>}

                  <div className="billing-plan-divider-v2" />

                  <ul className="billing-plan-features-v2">
                    {plan.highlights.map((feat) => (
                      <li key={`${plan.planKey}-${feat}`} className="billing-plan-feature-v2">
                        <span className="billing-plan-check-v2" aria-hidden="true">
                          <svg
                            width="8"
                            height="8"
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
                  className={`billing-plan-cta-v2${isActive ? ' billing-plan-cta-v2--active' : ' billing-plan-cta-v2--subscribe'}${isPendingAction ? ' btn-loading' : ''}`}
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
        <div className="billing-empty-v2">
          <div className="billing-empty-icon-v2">
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
          <h3 className="billing-empty-title-v2">No published plans yet</h3>
          <p className="billing-empty-desc-v2">
            Publish a recurring Polar product with entitlement benefits and it will appear here
            automatically.
          </p>
        </div>
      )}
    </section>
  );

  return (
    <div id="tab-panel-billing" className="dashboard-tab-panel is-active" role="tabpanel">
      <div className="bento-grid">
        {query.isError && !hasAuthError && (
          <div className="bento-col-12">
            <AccountInlineError message="Failed to load billing. Please refresh." />
          </div>
        )}

        <div className="bento-col-12">
          {hasPolarAccess ? (
            /* ── SUBSCRIBED VIEW ── */
            <div className="billing-layout">
              {/* Status hero */}
              <section className="billing-sub-hero">
                <div className="billing-sub-hero-left">
                  <div
                    className={`billing-pulse${statusVariant === 'warning' ? ' billing-pulse--warning' : statusVariant !== 'active' ? ' billing-pulse--inactive' : ''}`}
                    aria-hidden="true"
                  />
                  <div>
                    <h1 className="billing-sub-plan-name">
                      {currentPlan?.displayName ?? 'Creator Suite'}
                    </h1>
                    <p className="billing-sub-meta">
                      {statusCopy.badgeLabel}
                      {billing?.currentPeriodEnd && (
                        <> · Renews {formatCertificateDate(billing.currentPeriodEnd)}</>
                      )}
                    </p>
                  </div>
                </div>
                <div className="billing-sub-hero-actions">
                  <Link
                    to="/dashboard/certificates"
                    search={(prev) => ({ ...prev, guild_id: undefined, tenant_id: undefined })}
                    className="account-btn account-btn--secondary"
                    style={{ borderRadius: '10px', fontSize: '13px' }}
                  >
                    Certificates
                  </Link>
                  <YucpButton
                    yucp="primary"
                    isLoading={portalMut.isPending}
                    isDisabled={portalMut.isPending}
                    className="rounded-full text-[13px]"
                    onClick={() => portalMut.mutate()}
                  >
                    {!portalMut.isPending && (
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
                    {portalMut.isPending ? 'Opening…' : 'Manage Subscription'}
                  </YucpButton>
                </div>
              </section>

              {/* Metrics row */}
              <div className="billing-metrics-row">
                <article className="billing-metric-tile billing-metric-tile--featured">
                  <span className="billing-metric-label">Sign Quota</span>
                  <strong className="billing-metric-value">
                    {formatQuota(billing?.signQuotaPerPeriod ?? null)}
                  </strong>
                  <span className="billing-metric-sub">per billing period</span>
                </article>

                <article className="billing-metric-tile billing-metric-tile--devices">
                  <span className="billing-metric-label">Active Devices</span>
                  <strong className="billing-metric-value">
                    {billing?.activeDeviceCount ?? 0}
                    {billing?.deviceCap ? (
                      <span className="billing-metric-sub-value"> / {billing.deviceCap}</span>
                    ) : null}
                  </strong>
                  {billing?.deviceCap && billing.deviceCap > 0 && (
                    <div
                      className="billing-meter-v2"
                      role="progressbar"
                      aria-valuenow={billing.activeDeviceCount}
                      aria-valuemax={billing.deviceCap}
                    >
                      <div
                        className={`billing-meter-fill-v2${(billing.activeDeviceCount / billing.deviceCap) > 0.85 ? ' billing-meter-fill-v2--warning' : ''}`}
                        style={{
                          width: `${Math.min(100, (billing.activeDeviceCount / billing.deviceCap) * 100).toFixed(1)}%`,
                        }}
                      />
                    </div>
                  )}
                </article>

                {!!billing?.auditRetentionDays && (
                  <article className="billing-metric-tile">
                    <span className="billing-metric-label">Audit Retention</span>
                    <strong className="billing-metric-value">{billing.auditRetentionDays}</strong>
                    <span className="billing-metric-sub">days</span>
                  </article>
                )}

                {(overview?.meters ?? []).map((meter) => {
                  const total = meter.consumedUnits + meter.balance;
                  const pct = total > 0 ? (meter.consumedUnits / total) * 100 : 0;
                  return (
                    <article
                      key={meter.meterId}
                      className="billing-metric-tile billing-metric-tile--devices"
                    >
                      <span className="billing-metric-label">
                        {meter.meterName ?? meter.meterId}
                      </span>
                      <strong className="billing-metric-value">
                        {formatMeterUnits(meter.consumedUnits)}
                      </strong>
                      <span className="billing-metric-sub">
                        {meter.balance > 0
                          ? `${formatMeterUnits(meter.balance)} remaining`
                          : `${formatMeterUnits(meter.creditedUnits)} credited`}
                      </span>
                      {total > 0 && (
                        <div
                          className="billing-meter-v2"
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuenow={meter.consumedUnits}
                          aria-valuemax={total}
                        >
                          <div
                            className={`billing-meter-fill-v2${pct > 85 ? ' billing-meter-fill-v2--warning' : ''}`}
                            style={{ width: `${pct.toFixed(1)}%` }}
                          />
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>

              {/* Active capabilities */}
              {activeCapabilityLabels.length > 0 && (
                <section className="billing-caps-section">
                  <p className="billing-caps-label">Active Capabilities</p>
                  <div className="billing-caps-chips">
                    {activeCapabilityLabels.map((label) => (
                      <span key={label} className="billing-cap-chip">
                        <span className="billing-cap-dot" aria-hidden="true" />
                        {label}
                      </span>
                    ))}
                  </div>
                </section>
              )}

              {/* Plans grid (to compare / upgrade) */}
              {hasPlans && plansSection}
            </div>
          ) : (
            /* ── UPSELL VIEW ── */
            <div className="billing-layout">
              {/* Sales hero */}
              <section className="billing-hero">
                <div className="billing-hero-inner">
                  {/* Left: copy */}
                  <div className="billing-hero-left">
                    <span className="billing-hero-eyebrow">
                      <img
                        src="/Icons/Polar.svg"
                        alt=""
                        aria-hidden="true"
                        width="12"
                        height="12"
                      />
                      Creator Suite via Polar
                    </span>
                    <h1 className="billing-hero-title">
                      Your work, protected from studio to shelf.
                    </h1>
                    <p className="billing-hero-copy">
                      Gate exports. Sign every release. Trace couplings back to source. The complete
                      creator protection stack, activated by one subscription.
                    </p>
                    <div className="billing-hero-actions">
                      <button
                        type="button"
                        className="billing-hero-cta"
                        onClick={() => {
                          document
                            .getElementById('billing-plans-anchor')
                            ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }}
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                        See Plans
                      </button>
                      <Link
                        to="/dashboard/certificates"
                        search={(prev) => ({
                          ...prev,
                          guild_id: undefined,
                          tenant_id: undefined,
                        })}
                        className="billing-hero-link"
                      >
                        View Certificates
                      </Link>
                    </div>
                  </div>

                  {/* Right: feature tiles */}
                  <div className="billing-hero-right">
                    {(
                      [
                        {
                          icon: '/Icons/Shield.png',
                          title: 'Protected exports',
                          tag: 'Export gating',
                        },
                        {
                          icon: '/Icons/Key.png',
                          title: 'Certificate signing',
                          tag: 'Signing & revocation',
                        },
                        {
                          icon: '/Icons/Laptop.png',
                          title: 'Moderation lookup',
                          tag: 'Trust tooling',
                        },
                        {
                          icon: '/Icons/Wrench.png',
                          title: 'Coupling traceability',
                          tag: 'Forensics & lineage',
                        },
                      ] as const
                    ).map(({ icon, title, tag }) => (
                      <div key={title} className="billing-hero-feat-tile">
                        <div className="billing-hero-feat-icon">
                          <img
                            src={icon}
                            alt=""
                            aria-hidden="true"
                            width="16"
                            height="16"
                            style={{ objectFit: 'contain' }}
                          />
                        </div>
                        <div>
                          <p className="billing-hero-feat-title">{title}</p>
                          <p className="billing-hero-feat-tag">{tag}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </section>

              {/* What unlocks */}
              <section className="billing-unlocks">
                <div className="billing-section-hd">
                  <p className="billing-eyebrow">What you get</p>
                  <h2 className="billing-section-h2">One subscription. Full control.</h2>
                </div>
                <div className="billing-unlocks-grid">
                  {(
                    [
                      {
                        icon: '/Icons/Shield.png',
                        title: 'Protected exports',
                        desc: 'Gate high-trust releases to verified buyers only. No more hoping your files stay where you send them.',
                      },
                      {
                        icon: '/Icons/Wrench.png',
                        title: 'Coupling traceability',
                        desc: 'Every package linked back to its origin. Forensics and lineage always a click away.',
                      },
                      {
                        icon: '/Icons/Key.png',
                        title: 'Moderation lookup',
                        desc: 'Surface trust signals and moderation history when you need to make access decisions fast.',
                      },
                      {
                        icon: '/Icons/Laptop.png',
                        title: 'Certificate operations',
                        desc: 'Enroll machines, sign releases, and revoke access from one place -- independent of your storefront.',
                      },
                    ] as const
                  ).map(({ icon, title, desc }) => (
                    <div key={title} className="billing-unlock-card">
                      <div className="billing-unlock-icon">
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
                        <p className="billing-unlock-title">{title}</p>
                        <p className="billing-unlock-desc">{desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {/* Plans */}
              <div id="billing-plans-anchor">{plansSection}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
