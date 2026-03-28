import { useState } from 'react';
import { AccountModal } from '@/components/account/AccountPage';
import {
  type CreatorCertificateBillingSummary,
  type CreatorCertificateDevice,
  type CreatorCertificatePlan,
  formatCertificateDate,
} from '@/lib/certificates';

export function formatQuota(value: number | null) {
  return value === null ? 'Unlimited' : value.toLocaleString();
}

export function formatMeterUnits(value: number) {
  return value.toLocaleString();
}

export function buildPlanHighlights(plan: CreatorCertificatePlan) {
  if (plan.highlights.length > 0) {
    return plan.highlights;
  }

  return [
    `${plan.deviceCap} signing machine${plan.deviceCap !== 1 ? 's' : ''}`,
    `${formatQuota(plan.signQuotaPerPeriod)} signatures per period`,
    `${plan.auditRetentionDays}-day audit log retention`,
    `${plan.supportTier === 'premium' ? 'Premium' : 'Standard'} support`,
    ...plan.meteredPrices.map((price) => `${price.meterName} usage billing`),
  ];
}

export function CertificatePlanCard({
  plan,
  isCurrentPlan,
  isDisabled,
  isPending,
  onCheckout,
}: Readonly<{
  plan: CreatorCertificatePlan;
  isCurrentPlan: boolean;
  isDisabled: boolean;
  isPending: boolean;
  onCheckout: (plan: CreatorCertificatePlan) => void;
}>) {
  const highlights = buildPlanHighlights(plan);

  return (
    <article className={`account-plan-card ${isCurrentPlan ? 'is-current' : ''}`}>
      <div className="account-plan-title-row">
        <div>
          <h3 className="account-plan-name">{plan.displayName}</h3>
          {plan.displayBadge && <p className="account-plan-meta">{plan.displayBadge}</p>}
          {plan.description && <p className="account-plan-meta">{plan.description}</p>}
        </div>
        {isCurrentPlan && <span className="account-badge account-badge--connected">Active</span>}
      </div>

      <ul className="account-plan-feature-list">
        {highlights.map((highlight) => (
          <li key={`${plan.planKey}-${highlight}`}>{highlight}</li>
        ))}
      </ul>

      <button
        type="button"
        className={`account-btn account-btn--${isCurrentPlan ? 'secondary' : 'primary'}${isPending ? ' btn-loading' : ''}`}
        style={{ width: '100%', justifyContent: 'center', borderRadius: '999px' }}
        onClick={() => onCheckout(plan)}
        disabled={isPending || isDisabled || isCurrentPlan}
      >
        {isPending ? (
          <span className="btn-loading-spinner" aria-hidden="true" />
        ) : isCurrentPlan ? (
          'Current Plan'
        ) : (
          <>
            <img src="/Icons/Polar.svg" alt="" aria-hidden="true" className="cert-polar-btn-icon" />
            Subscribe via Polar
          </>
        )}
      </button>
    </article>
  );
}

export function CertificateDeviceRow({
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
          style={{ opacity: isActive ? 1 : 0.4 }}
        />
      </div>

      <div className="account-list-row-info">
        <p className="account-list-row-name">{device.publisherName}</p>
        <div className="account-list-row-meta">
          <span className="account-reference-chip">{device.devPublicKey.slice(0, 20)}…</span>
          <span className={`account-badge account-badge--${isActive ? 'active' : 'revoked'}`}>
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
            if (!isRevoking) {
              setConfirming(false);
            }
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
              className={`account-btn account-btn--danger${isRevoking ? ' btn-loading' : ''}`}
              onClick={() => onRevoke(device.certNonce)}
              disabled={isRevoking}
            >
              {isRevoking ? (
                <span className="btn-loading-spinner" aria-hidden="true" />
              ) : (
                'Confirm Revocation'
              )}
            </button>
          </div>
        </AccountModal>
      )}
    </div>
  );
}

export function CertificateFeatureShowcase() {
  return (
    <div className="cert-features-grid">
      {(
        [
          {
            icon: '/Icons/Shield.png',
            colorClass: 'cert-feature-icon--blue',
            title: 'Verified identity',
            desc: 'Packages are signed with a certificate tied to your creator profile.',
          },
          {
            icon: '/Icons/Laptop.png',
            colorClass: 'cert-feature-icon--green',
            title: 'Multi-device signing',
            desc: 'Authorize multiple publishing machines under one account.',
          },
          {
            icon: '/Icons/Key.png',
            colorClass: 'cert-feature-icon--amber',
            title: 'Instant revocation',
            desc: 'Remove any device in one click and invalidate its signing certificate.',
          },
          {
            icon: '/Icons/Wrench.png',
            colorClass: 'cert-feature-icon--purple',
            title: 'Audit visibility',
            desc: 'Review limits, retention, and usage directly from Polar-backed billing data.',
          },
        ] as const
      ).map(({ icon, colorClass, title, desc }) => (
        <div key={title} className="cert-feature-item">
          <div className={`cert-feature-icon ${colorClass}`}>
            <img src={icon} alt="" aria-hidden="true" />
          </div>
          <div className="cert-feature-copy">
            <p className="cert-feature-title">{title}</p>
            <p className="cert-feature-desc">{desc}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function buildBillingStatusCopy(billing: CreatorCertificateBillingSummary | undefined) {
  if (!billing) {
    return {
      badgeClass: 'provider',
      badgeLabel: 'Loading',
      description: 'Resolving your certificate billing state.',
    };
  }

  switch (billing.status) {
    case 'active':
      return {
        badgeClass: 'active',
        badgeLabel: 'Active',
        description: billing.allowSigning
          ? 'Certificates can sign and enroll machines right now.'
          : 'Access is active, but signing is currently restricted.',
      };
    case 'grace':
      return {
        badgeClass: 'warning',
        badgeLabel: 'Grace',
        description: 'Access is limited until Polar confirms the next billing transition.',
      };
    default:
      return {
        badgeClass: 'provider',
        badgeLabel: 'Inactive',
        description: billing.reason ?? 'Choose a Polar plan to unlock signing and enrollment.',
      };
  }
}
