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
  listUserOAuthGrants,
  type OAuthGrant,
  revokeUserOAuthGrant,
} from '@/lib/account';

function AccountAuthorizedAppsPending() {
  return (
    <AccountPage>
      <DashboardListSkeleton rows={2} />
    </AccountPage>
  );
}

export const Route = createFileRoute('/account/authorized-apps')({
  pendingComponent: AccountAuthorizedAppsPending,
  component: AccountAuthorizedApps,
});

function GrantRow({ grant }: Readonly<{ grant: OAuthGrant }>) {
  const [confirming, setConfirming] = useState(false);
  const queryClient = useQueryClient();
  const toast = useToast();

  const revokeMut = useMutation({
    mutationFn: () => revokeUserOAuthGrant(grant.consentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-oauth-grants'] });
      setConfirming(false);
      toast.success('App access revoked', {
        description: `${grant.appName} must be authorized again before it can use your account.`,
      });
    },
    onError: () => {
      toast.error('Could not revoke app access', {
        description: `Please try revoking ${grant.appName} again.`,
      });
    },
  });

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
          <path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z" />
        </svg>
      </div>

      <div className="account-list-row-info">
        <p className="account-list-row-name">{grant.appName}</p>
        <p className="account-list-row-meta">
          <span className="account-reference-chip">{grant.clientId}</span>
          {grant.grantedAt ? <span>Authorized {formatAccountDate(grant.grantedAt)}</span> : null}
        </p>
        {grant.scopes.length > 0 ? (
          <div className="account-pill-row account-pill-row--compact">
            {grant.scopes.map((scope) => (
              <span key={scope} className="account-badge account-badge--scope">
                {scope}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="account-list-row-actions">
        {!confirming ? (
          <button
            type="button"
            className="account-btn account-btn--danger"
            onClick={() => setConfirming(true)}
          >
            Revoke
          </button>
        ) : null}
        {confirming ? (
          <AccountModal title={`Revoke ${grant.appName}?`} onClose={() => setConfirming(false)}>
            <p className="account-modal-body">
              Revoking access immediately invalidates this client&apos;s ability to use your
              account. Any existing access tokens must be reissued after a new consent flow.
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
                    Revoking...
                  </>
                ) : (
                  'Revoke access'
                )}
              </button>
            </div>
          </AccountModal>
        ) : null}
      </div>
    </div>
  );
}

function AccountAuthorizedApps() {
  const grantsQuery = useQuery({
    queryKey: ['user-oauth-grants'],
    queryFn: listUserOAuthGrants,
  });

  const grants = grantsQuery.data ?? [];
  const uniqueScopeCount = useMemo(
    () => new Set(grants.flatMap((grant) => grant.scopes)).size,
    [grants]
  );

  return (
    <AccountPage>
      <AccountSectionCard
        className="bento-col-8 animate-in animate-in-delay-1"
        eyebrow="Consent ledger"
        title="Authorized applications"
        description="Review every app that currently has delegated access to your account."
      >
        {grantsQuery.isLoading ? (
          <div className="account-skeleton-stack">
            <div className="account-skeleton-row" />
            <div className="account-skeleton-row" style={{ width: '74%' }} />
          </div>
        ) : null}

        {grantsQuery.isError ? (
          <AccountInlineError message="Failed to load authorized apps. Please refresh." />
        ) : null}

        {!grantsQuery.isLoading && !grantsQuery.isError && grants.length === 0 ? (
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
                <path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z" />
              </svg>
            }
            title="No authorized apps"
            description="Apps you authorize with your account will appear here. You can revoke access at any time."
          />
        ) : null}

        {!grantsQuery.isLoading && !grantsQuery.isError && grants.length > 0
          ? grants.map((grant) => <GrantRow key={grant.consentId} grant={grant} />)
          : null}
      </AccountSectionCard>

      <AccountSectionCard
        className="bento-col-4 animate-in animate-in-delay-2"
        eyebrow="Security"
        title="What revocation means"
        description="Revoking consent is immediate and cuts off the app until it sends you through a new authorization flow."
      >
        <div className="account-kv-list">
          <div className="account-kv-row">
            <span className="account-kv-label">Authorized clients</span>
            <span className="account-kv-value">
              {grantsQuery.isLoading ? '...' : grants.length}
            </span>
          </div>
          <div className="account-kv-row">
            <span className="account-kv-label">Unique scopes</span>
            <span className="account-kv-value">
              {grantsQuery.isLoading ? '...' : uniqueScopeCount}
            </span>
          </div>
        </div>

        <div className="account-note-stack">
          <p className="account-feature-copy">
            Revoke access when an app is no longer in use, when permissions changed unexpectedly, or
            when you want to force a clean re-authorization.
          </p>
          <p className="account-feature-copy">
            Scope badges reflect the exact strings stored on the consent grant, so they are useful
            when auditing app access.
          </p>
        </div>
      </AccountSectionCard>
    </AccountPage>
  );
}
