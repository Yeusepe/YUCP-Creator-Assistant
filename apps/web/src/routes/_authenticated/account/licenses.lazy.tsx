import { Tooltip } from '@heroui/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createLazyFileRoute } from '@tanstack/react-router';
import { motion } from 'framer-motion';
import { useMemo, useState } from 'react';
import {
  AccountEmptyState,
  AccountInlineError,
  AccountModal,
  AccountPage,
  AccountSectionCard,
} from '@/components/account/AccountPage';
import { DashboardListSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { ProviderChip } from '@/components/ui/ProviderChip';
import { type BadgeStatus, StatusChip } from '@/components/ui/StatusChip';
import { useToast } from '@/components/ui/Toast';
import { YucpButton } from '@/components/ui/YucpButton';
import {
  formatAccountDate,
  getAccountProviderIconPath,
  listUserLicenses,
  revokeUserLicense,
  type UserLicenseEntitlement,
} from '@/lib/account';

function AccountLicensesPending() {
  return (
    <AccountPage>
      <DashboardListSkeleton rows={3} />
    </AccountPage>
  );
}

export const Route = createLazyFileRoute('/_authenticated/account/licenses')({
  pendingComponent: AccountLicensesPending,
  component: AccountLicenses,
});

function EntitlementRow({
  entitlement,
  index,
}: Readonly<{ entitlement: UserLicenseEntitlement; index: number }>) {
  const [confirming, setConfirming] = useState(false);
  const queryClient = useQueryClient();
  const toast = useToast();
  const rowDelay = Math.min(index * 0.05, 0.25);

  const revokeMut = useMutation({
    mutationFn: () => revokeUserLicense(entitlement.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-licenses'] });
      setConfirming(false);
      toast.success('License deactivated', {
        description: 'The associated Discord role will be removed on the next sync.',
      });
    },
    onError: () => {
      toast.error('Could not deactivate license', {
        description: 'Please try again or re-run verification if the problem persists.',
      });
    },
  });

  const iconPath = getAccountProviderIconPath(entitlement.sourceProvider);

  return (
    <motion.div
      className="account-list-row"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: rowDelay, duration: 0.28, ease: [0.25, 0.46, 0.45, 0.94] }}
    >
      <div className="account-list-row-icon">
        {iconPath ? (
          <img src={iconPath} alt={entitlement.sourceProvider} width="20" height="20" />
        ) : (
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
            <path d="M20 7H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z" />
            <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
            <circle cx="12" cy="13" r="1" />
          </svg>
        )}
      </div>

      <div className="account-list-row-info">
        <p className="account-list-row-name">{entitlement.productId}</p>
        <div className="account-list-row-meta">
          <ProviderChip name={entitlement.sourceProvider} />
          {entitlement.sourceReference ? (
            <Tooltip>
              <button
                type="button"
                className="account-reference-chip"
                style={{ cursor: 'help' }}
                aria-label={entitlement.sourceReference}
              >
                {entitlement.sourceReference.slice(0, 12)}
                &hellip;
              </button>
              <Tooltip.Content>
                <p style={{ fontFamily: 'ui-monospace, monospace', fontSize: '11px' }}>
                  {entitlement.sourceReference}
                </p>
              </Tooltip.Content>
            </Tooltip>
          ) : null}
          <span>{formatAccountDate(entitlement.grantedAt)}</span>
        </div>
      </div>

      <div className="account-list-row-actions">
        {(['active', 'revoked', 'expired'] as BadgeStatus[]).includes(
          entitlement.status as BadgeStatus
        ) ? (
          <StatusChip
            status={entitlement.status as BadgeStatus}
            label={entitlement.status.charAt(0).toUpperCase() + entitlement.status.slice(1)}
          />
        ) : (
          <ProviderChip
            name={entitlement.status.charAt(0).toUpperCase() + entitlement.status.slice(1)}
          />
        )}
        {entitlement.status === 'active' && !confirming ? (
          <YucpButton yucp="ghost" onClick={() => setConfirming(true)}>
            Deactivate
          </YucpButton>
        ) : null}
        {confirming ? (
          <AccountModal title="Deactivate license?" onClose={() => setConfirming(false)}>
            <p className="account-modal-body">
              This removes the active grant from your account and revokes the linked Discord role.
              Re-verification requires the full provider flow again.
            </p>
            <div className="account-modal-actions">
              <YucpButton
                yucp="secondary"
                onClick={() => setConfirming(false)}
                isDisabled={revokeMut.isPending}
              >
                Cancel
              </YucpButton>
              <YucpButton
                yucp="danger"
                isLoading={revokeMut.isPending}
                isDisabled={revokeMut.isPending}
                onClick={() => revokeMut.mutate()}
              >
                {revokeMut.isPending ? 'Deactivating...' : 'Deactivate'}
              </YucpButton>
            </div>
          </AccountModal>
        ) : null}
      </div>
    </motion.div>
  );
}

function AccountLicenses() {
  const licensesQuery = useQuery({
    queryKey: ['user-licenses'],
    queryFn: listUserLicenses,
  });

  const subjects = licensesQuery.data ?? [];
  const allEntitlements = useMemo(
    () => subjects.flatMap((subject) => subject.entitlements),
    [subjects]
  );
  const activeCount = allEntitlements.filter(
    (entitlement) => entitlement.status === 'active'
  ).length;
  const providerCount = new Set(allEntitlements.map((entitlement) => entitlement.sourceProvider))
    .size;

  return (
    <AccountPage>
      <AccountSectionCard
        className="bento-col-8 animate-in animate-in-delay-1"
        eyebrow="License ledger"
        title="Verified purchases"
        description="Review every entitlement this account has received from storefront verification."
      >
        {licensesQuery.isLoading ? (
          <div className="account-skeleton-stack">
            <div className="account-skeleton-row" />
            <div className="account-skeleton-row" style={{ width: '78%' }} />
            <div className="account-skeleton-row" style={{ width: '64%' }} />
          </div>
        ) : null}

        {licensesQuery.isError ? (
          <AccountInlineError message="Failed to load licenses. Please refresh." />
        ) : null}

        {!licensesQuery.isLoading && !licensesQuery.isError && allEntitlements.length === 0 ? (
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
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M9 9h6M9 13h4" />
              </svg>
            }
            title="No verified purchases yet"
            description={
              <>
                Join a server that uses Creator Assistant, then run{' '}
                <span className="account-reference-chip">/verify</span> to connect your purchase.
              </>
            }
          />
        ) : null}

        {!licensesQuery.isLoading && !licensesQuery.isError && allEntitlements.length > 0
          ? allEntitlements.map((entitlement, index) => (
              <EntitlementRow key={entitlement.id} entitlement={entitlement} index={index} />
            ))
          : null}
      </AccountSectionCard>

      <AccountSectionCard
        className="bento-col-4 animate-in animate-in-delay-2"
        eyebrow="Context"
        title="What deactivation does"
        description="Removing an entitlement updates the account record and revokes the role granted by this verification system."
      >
        <div className="account-kv-list">
          <div className="account-kv-row">
            <span className="account-kv-label">Active grants</span>
            <span className="account-kv-value">
              {licensesQuery.isLoading ? '...' : activeCount}
            </span>
          </div>
          <div className="account-kv-row">
            <span className="account-kv-label">Total purchases</span>
            <span className="account-kv-value">
              {licensesQuery.isLoading ? '...' : allEntitlements.length}
            </span>
          </div>
          <div className="account-kv-row">
            <span className="account-kv-label">Sources</span>
            <span className="account-kv-value">
              {licensesQuery.isLoading ? '...' : providerCount}
            </span>
          </div>
        </div>

        <div className="account-note-stack">
          <p className="account-feature-copy">
            Use deactivation when you want to remove access from this account. If you bought the
            same product again later, the provider flow can grant a fresh entitlement.
          </p>
          <p className="account-feature-copy">
            Purchases are grouped under {subjects.length} verified subject
            {subjects.length === 1 ? '' : 's'} right now.
          </p>
        </div>
      </AccountSectionCard>
    </AccountPage>
  );
}
