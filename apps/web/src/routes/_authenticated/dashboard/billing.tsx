import { PolarEmbedCheckout } from '@polar-sh/checkout/embed';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { AccountInlineError } from '@/components/account/AccountPage';
import { DashboardAuthRequiredState } from '@/components/dashboard/AuthRequiredState';
import {
  buildBillingStatusCopy,
  CertificateFeatureShowcase,
  CertificatePlanCard,
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
            <AccountInlineError message="Failed to load Polar billing. Please refresh." />
          </div>
        )}

        <section className="intg-card animate-in bento-col-8 cert-billing-hero">
          <div className="cert-billing-hero-backdrop" aria-hidden="true" />
          <div className="cert-billing-hero-row">
            <div className="cert-billing-hero-copy">
              <span className="cert-billing-kicker">Polar Billing</span>
              <h1 className="cert-billing-title">
                {currentPlan?.displayName ?? 'Code Signing Billing'}
              </h1>
              <p className="cert-billing-desc">
                {hasPolarAccess
                  ? 'Plan data, feature flags, and usage now come directly from Polar. Changes happen in the embedded checkout or the Polar portal, not in local config.'
                  : 'Browse live plans from Polar, start checkout in-place, and keep certificates separate from commerce management.'}
              </p>
            </div>
            <div className="cert-billing-hero-actions">
              <button
                type="button"
                className={`account-btn account-btn--secondary${portalMut.isPending ? ' btn-loading' : ''}`}
                style={{ borderRadius: '999px' }}
                onClick={() => portalMut.mutate()}
                disabled={portalMut.isPending}
              >
                {portalMut.isPending ? (
                  <span className="btn-loading-spinner" aria-hidden="true" />
                ) : (
                  <img
                    src="/Icons/Polar.svg"
                    alt=""
                    aria-hidden="true"
                    className="cert-polar-btn-icon"
                  />
                )}
                {portalMut.isPending ? 'Opening...' : 'Open Polar Portal'}
              </button>
              <Link
                to="/dashboard/certificates"
                search={(prev) => ({ ...prev, guild_id: undefined, tenant_id: undefined })}
                className="account-btn account-btn--primary"
                style={{ borderRadius: '999px' }}
              >
                View Certificates
              </Link>
            </div>
          </div>

          <div className="cert-billing-chip-row">
            <span className={`account-badge account-badge--${statusCopy.badgeClass}`}>
              {statusCopy.badgeLabel}
            </span>
            {currentPlan?.displayBadge && (
              <span className="cert-billing-chip">{currentPlan.displayBadge}</span>
            )}
            {billing?.supportTier && (
              <span className="cert-billing-chip">
                {billing.supportTier === 'premium' ? 'Premium support' : 'Standard support'}
              </span>
            )}
            {billing?.currentPeriodEnd && (
              <span className="cert-billing-chip">
                Renews {formatCertificateDate(billing.currentPeriodEnd)}
              </span>
            )}
          </div>

          <p className="cert-billing-footnote">{statusCopy.description}</p>
        </section>

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
            <div className="intg-copy">
              <h2 className="intg-title">Current Access</h2>
              <p className="intg-desc">What Polar is granting right now.</p>
            </div>
          </div>

          <div className="cert-billing-metric-grid cert-billing-metric-grid--compact">
            <article className="cert-billing-metric-card">
              <span className="cert-billing-metric-label">Enrollment</span>
              <strong className="cert-billing-metric-value">
                {billing?.allowEnrollment ? 'Open' : 'Closed'}
              </strong>
            </article>
            <article className="cert-billing-metric-card">
              <span className="cert-billing-metric-label">Signing</span>
              <strong className="cert-billing-metric-value">
                {billing?.allowSigning ? 'Enabled' : 'Restricted'}
              </strong>
            </article>
            <article className="cert-billing-metric-card">
              <span className="cert-billing-metric-label">Device Cap</span>
              <strong className="cert-billing-metric-value">
                {billing?.deviceCap ?? 'Unlimited'}
              </strong>
            </article>
            <article className="cert-billing-metric-card">
              <span className="cert-billing-metric-label">Audit Retention</span>
              <strong className="cert-billing-metric-value">
                {billing?.auditRetentionDays ? `${billing.auditRetentionDays} days` : 'Unavailable'}
              </strong>
            </article>
          </div>
        </section>

        <section className="intg-card animate-in animate-in-delay-1 bento-col-12">
          <div className="intg-header">
            <div className="intg-icon">
              <img
                src="/Icons/Wrench.png"
                alt=""
                aria-hidden="true"
                style={{ width: '22px', height: '22px', objectFit: 'contain' }}
              />
            </div>
            <div className="intg-copy">
              <h2 className="intg-title">Live Entitlements</h2>
              <p className="intg-desc">
                This mirrors the current Polar product, benefit metadata, and meter state.
              </p>
            </div>
          </div>

          <div className="cert-billing-metric-grid">
            <article className="cert-billing-metric-card">
              <span className="cert-billing-metric-label">Plan</span>
              <strong className="cert-billing-metric-value">
                {currentPlan?.displayName ?? 'No active plan'}
              </strong>
            </article>
            <article className="cert-billing-metric-card">
              <span className="cert-billing-metric-label">Sign Quota</span>
              <strong className="cert-billing-metric-value">
                {formatQuota(billing?.signQuotaPerPeriod ?? null)}
              </strong>
            </article>
            <article className="cert-billing-metric-card">
              <span className="cert-billing-metric-label">Capabilities</span>
              <strong className="cert-billing-metric-value">
                {billing?.capabilities.length ? `${billing.capabilities.length} flags` : 'No flags'}
              </strong>
            </article>
            <article className="cert-billing-metric-card">
              <span className="cert-billing-metric-label">Active Devices</span>
              <strong className="cert-billing-metric-value">
                {billing?.activeDeviceCount ?? 0}
              </strong>
            </article>
            {(overview?.meters ?? []).map((meter) => (
              <article key={meter.meterId} className="cert-billing-metric-card">
                <span className="cert-billing-metric-label">
                  {meter.meterName ?? meter.meterId}
                </span>
                <strong className="cert-billing-metric-value">
                  {formatMeterUnits(meter.consumedUnits)} used
                </strong>
                <span className="cert-billing-metric-note">
                  {meter.balance > 0
                    ? `${formatMeterUnits(meter.balance)} remaining`
                    : `${formatMeterUnits(meter.creditedUnits)} credited`}
                </span>
              </article>
            ))}
          </div>
        </section>

        {!hasPolarAccess && (
          <section className="intg-card animate-in animate-in-delay-2 bento-col-5">
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
                <h2 className="intg-title">Before You Subscribe</h2>
                <p className="intg-desc">
                  Checkout is embedded here. Certificates stay on their own page once access is
                  live.
                </p>
              </div>
            </div>
            <CertificateFeatureShowcase />
          </section>
        )}

        <section
          className={`intg-card animate-in animate-in-delay-2 ${hasPolarAccess ? 'bento-col-12' : 'bento-col-7'}`}
        >
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
              <h2 id="billing-plans" className="intg-title">
                Plans from Polar
              </h2>
              <p className="intg-desc">
                Live product names, descriptions, benefits, and meter-backed pricing are rendered
                directly from the Polar catalog.
              </p>
            </div>
            <span className="account-polar-badge">
              <img src="/Icons/Polar.svg" alt="" aria-hidden="true" />
              Polar
            </span>
          </div>

          {hasPlans ? (
            <div className="account-plan-grid">
              {overview?.availablePlans.map((plan) => (
                <CertificatePlanCard
                  key={plan.planKey}
                  plan={plan}
                  isCurrentPlan={
                    hasPolarAccess &&
                    (billing?.productId === plan.productId || billing?.planKey === plan.planKey)
                  }
                  isDisabled={isCheckoutBusy}
                  isPending={
                    (pendingProductId === plan.productId ||
                      confirmedProductId === plan.productId) &&
                    isCheckoutBusy
                  }
                  onCheckout={handleCheckout}
                />
              ))}
            </div>
          ) : (
            <div className="account-empty">
              <div className="account-empty-icon">
                <img
                  src="/Icons/Polar.svg"
                  alt=""
                  aria-hidden="true"
                  style={{ width: '20px', height: '20px', objectFit: 'contain', opacity: 0.5 }}
                />
              </div>
              <p className="account-empty-title">No published billing plans yet</p>
              <p className="account-empty-desc">
                Add a Polar product with <code>yucp_domain=certificate_billing</code> metadata and
                it will appear here automatically.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
