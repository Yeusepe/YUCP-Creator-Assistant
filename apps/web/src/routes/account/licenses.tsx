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
import { DashboardListSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { useToast } from '@/components/ui/Toast';
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

export const Route = createFileRoute('/account/licenses')({
  pendingComponent: AccountLicensesPending,
  component: AccountLicenses,
});

function EntitlementRow({ entitlement }: Readonly<{ entitlement: UserLicenseEntitlement }>) {
  const [confirming, setConfirming] = useState(false);
  const queryClient = useQueryClient();
  const toast = useToast();

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
    <div className="account-list-row">
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
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 9h6M9 13h4" />
          </svg>
        )}
      </div>

      <div className="account-list-row-info">
        <p className="account-list-row-name">{entitlement.productId}</p>
        <p className="account-list-row-meta">
          <span className="account-badge account-badge--provider">
            {entitlement.sourceProvider}
          </span>
          {entitlement.sourceReference ? (
            <span className="account-reference-chip">
              {entitlement.sourceReference.slice(0, 12)}
              &hellip;
            </span>
          ) : null}
          <span>{formatAccountDate(entitlement.grantedAt)}</span>
        </p>
      </div>

      <div className="account-list-row-actions">
        <span className={`account-badge account-badge--${entitlement.status}`}>
          {entitlement.status.charAt(0).toUpperCase() + entitlement.status.slice(1)}
        </span>
        {entitlement.status === 'active' && !confirming ? (
          <button
            type="button"
            className="account-btn account-btn--danger"
            onClick={() => setConfirming(true)}
          >
            Deactivate
          </button>
        ) : null}
        {confirming ? (
          <AccountModal title="Deactivate license?" onClose={() => setConfirming(false)}>
            <p className="account-modal-body">
              This removes the active grant from your account and revokes the linked Discord role.
              Re-verification requires the full provider flow again.
            </p>
            <div className="account-modal-actions">
              <button
                type="button"
                className="account-btn account-btn--secondary"
                onClick={() => setConfirming(false)}
                disabled={revokeMut.isPending}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`account-btn account-btn--danger${revokeMut.isPending ? ' btn-loading' : ''}`}
                onClick={() => revokeMut.mutate()}
                disabled={revokeMut.isPending}
              >
                {revokeMut.isPending ? (
                  <>
                    <span className="btn-loading-spinner" aria-hidden="true" />
                    Deactivating...
                  </>
                ) : (
                  'Deactivate'
                )}
              </button>
            </div>
          </AccountModal>
        ) : null}
      </div>
    </div>
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
          ? allEntitlements.map((entitlement) => (
              <EntitlementRow key={entitlement.id} entitlement={entitlement} />
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
