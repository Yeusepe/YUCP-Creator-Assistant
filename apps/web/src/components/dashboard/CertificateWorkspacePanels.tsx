import { useState } from 'react';
import { AccountModal } from '@/components/account/AccountPage';
import { type BadgeStatus, StatusChip } from '@/components/ui/StatusChip';
import { YucpButton } from '@/components/ui/YucpButton';
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

export function formatCapabilityLabel(capabilityKey: string) {
  const trimmed = capabilityKey.trim();
  if (!trimmed) {
    return 'Unknown capability';
  }

  const normalized = trimmed
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());

  if (normalized.length === 0) {
    return 'Unknown capability';
  }

  const acronymSegments = new Set(['api', 'sdk', 'sso', 'cli']);

  return normalized
    .map((segment) =>
      acronymSegments.has(segment)
        ? segment.toUpperCase()
        : `${segment[0]?.toUpperCase() ?? ''}${segment.slice(1)}`
    )
    .join(' ');
}

export function buildPlanHighlights(plan: CreatorCertificatePlan) {
  const defaultHighlights = [
    `${plan.deviceCap} signing machine${plan.deviceCap !== 1 ? 's' : ''}`,
    `${formatQuota(plan.signQuotaPerPeriod)} signatures per period`,
    `${plan.auditRetentionDays}-day audit log retention`,
    `${plan.supportTier === 'premium' ? 'Premium' : 'Standard'} support`,
    ...plan.capabilities.map((capability) => formatCapabilityLabel(capability)),
    ...plan.meteredPrices.map((price) => `${price.meterName} usage billing`),
  ];

  if (plan.highlights.length > 0) {
    return Array.from(new Set([...plan.highlights, ...defaultHighlights]));
  }

  return defaultHighlights;
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
        {isCurrentPlan && <StatusChip status="connected" label="Active" />}
      </div>

      <ul className="account-plan-feature-list">
        {highlights.map((highlight) => (
          <li key={`${plan.planKey}-${highlight}`}>{highlight}</li>
        ))}
      </ul>

      <YucpButton
        yucp={isCurrentPlan ? 'secondary' : 'primary'}
        pill
        isLoading={isPending}
        isDisabled={isPending || isDisabled || isCurrentPlan}
        className="w-full justify-center"
        onClick={() => onCheckout(plan)}
      >
        {isCurrentPlan ? (
          'Current Plan'
        ) : (
          <>
            <img src="/Icons/Polar.svg" alt="" aria-hidden="true" className="cert-polar-btn-icon" />
            Subscribe via Polar
          </>
        )}
      </YucpButton>
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
          <StatusChip
            status={(isActive ? 'active' : 'revoked') as BadgeStatus}
            label={device.status}
          />
          <span>Issued {formatCertificateDate(device.issuedAt)}</span>
          <span aria-hidden="true">·</span>
          <span>Expires {formatCertificateDate(device.expiresAt)}</span>
        </div>
      </div>

      <div className="account-list-row-actions">
        {isActive && (
          <YucpButton
            yucp="danger"
            className="rounded-[8px] text-[12px] px-3 py-[5px]"
            onClick={() => setConfirming(true)}
          >
            Revoke
          </YucpButton>
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
            <YucpButton
              yucp="secondary"
              onClick={() => setConfirming(false)}
              isDisabled={isRevoking}
            >
              Cancel
            </YucpButton>
            <YucpButton
              yucp="danger"
              isLoading={isRevoking}
              isDisabled={isRevoking}
              onClick={() => onRevoke(device.certNonce)}
            >
              {isRevoking ? 'Revoking...' : 'Confirm Revocation'}
            </YucpButton>
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
            desc: 'Packages are signed with a certificate tied to your Creator Identity.',
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

export function CreatorSuiteFeatureShowcase() {
  return (
    <div className="cert-features-grid">
      {(
        [
          {
            icon: '/Icons/Shield.png',
            colorClass: 'cert-feature-icon--blue',
            title: 'Protected exports',
            desc: 'Gate high-trust releases behind Polar-backed access instead of local plan JSON.',
          },
          {
            icon: '/Icons/Wrench.png',
            colorClass: 'cert-feature-icon--purple',
            title: 'Coupling traceability',
            desc: 'Unlock forensics and package lineage when the Polar benefit grant is active.',
          },
          {
            icon: '/Icons/Key.png',
            colorClass: 'cert-feature-icon--green',
            title: 'Moderation lookup',
            desc: 'Expose trust and moderation tooling directly from the same active Suite subscription.',
          },
          {
            icon: '/Icons/Laptop.png',
            colorClass: 'cert-feature-icon--amber',
            title: 'Certificate operations',
            desc: 'Keep machine enrollment, revocation, and signing controls separate from commerce.',
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
      badgeStatus: 'pending' as BadgeStatus,
      badgeLabel: 'Loading',
      description: 'Resolving your certificate billing state.',
    };
  }

  switch (billing.status) {
    case 'active':
      return {
        badgeClass: 'active',
        badgeStatus: 'active' as BadgeStatus,
        badgeLabel: 'Active',
        description: billing.allowSigning
          ? 'Certificates can sign and enroll machines right now.'
          : 'Access is active, but signing is currently restricted.',
      };
    case 'grace':
      return {
        badgeClass: 'warning',
        badgeStatus: 'warning' as BadgeStatus,
        badgeLabel: 'Grace',
        description: 'Access is limited until Polar confirms the next billing transition.',
      };
    default:
      return {
        badgeClass: 'provider',
        badgeStatus: 'disconnected' as BadgeStatus,
        badgeLabel: 'Inactive',
        description: billing.reason ?? 'Choose a Polar plan to unlock signing and enrollment.',
      };
  }
}
