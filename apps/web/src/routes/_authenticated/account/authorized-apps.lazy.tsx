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
import { useToast } from '@/components/ui/Toast';
import { YucpButton } from '@/components/ui/YucpButton';
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

export const Route = createLazyFileRoute('/_authenticated/account/authorized-apps')({
  pendingComponent: AccountAuthorizedAppsPending,
  component: AccountAuthorizedApps,
});

const USER_OAUTH_GRANTS_QUERY_KEY = ['user-oauth-grants'] as const;

function GrantRow({ grant, index }: Readonly<{ grant: OAuthGrant; index: number }>) {
  const [confirming, setConfirming] = useState(false);
  const queryClient = useQueryClient();
  const toast = useToast();

  const revokeMut = useMutation({
    mutationFn: () => revokeUserOAuthGrant(grant.consentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: USER_OAUTH_GRANTS_QUERY_KEY });
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

  const appInitial = grant.appName.slice(0, 1).toUpperCase();

  return (
    <motion.div
      className="account-list-row"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05, duration: 0.28, ease: [0.25, 0.46, 0.45, 0.94] }}
    >
      <div className="account-list-row-icon account-app-icon" aria-hidden="true">
        <span className="account-app-icon-letter">{appInitial}</span>
      </div>

      <div className="account-list-row-info">
        <p className="account-list-row-name">{grant.appName}</p>
        <p className="account-list-row-meta">
          <Tooltip>
            <Tooltip.Trigger>
              <span className="account-reference-chip" style={{ cursor: 'default' }}>
                {grant.clientId.length > 16
                  ? `${grant.clientId.slice(0, 16)}\u2026`
                  : grant.clientId}
              </span>
            </Tooltip.Trigger>
            <Tooltip.Content>
              <p style={{ fontFamily: 'ui-monospace, monospace', fontSize: '11px' }}>
                {grant.clientId}
              </p>
            </Tooltip.Content>
          </Tooltip>
          {grant.grantedAt ? <span>Authorized {formatAccountDate(grant.grantedAt)}</span> : null}
        </p>
        {grant.scopes.length > 0 ? (
          <div className="account-pill-row account-pill-row--compact">
            {grant.scopes.map((scope) => (
              <span
                key={`${grant.consentId}:${scope}`}
                className="account-badge account-badge--scope-neutral"
              >
                {scope}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="account-list-row-actions">
        {!confirming ? (
          <YucpButton yucp="ghost" onClick={() => setConfirming(true)}>
            Revoke
          </YucpButton>
        ) : null}
        {confirming ? (
          <AccountModal title={`Revoke ${grant.appName}?`} onClose={() => setConfirming(false)}>
            <p className="account-modal-body">
              Revoking access immediately invalidates this client&apos;s ability to use your
              account. Any existing access tokens must be reissued after a new consent flow.
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
                {revokeMut.isPending ? 'Revoking...' : 'Revoke access'}
              </YucpButton>
            </div>
          </AccountModal>
        ) : null}
      </div>
    </motion.div>
  );
}

function AccountAuthorizedApps() {
  const grantsQuery = useQuery({
    queryKey: USER_OAUTH_GRANTS_QUERY_KEY,
    queryFn: listUserOAuthGrants,
  });

  const grants = grantsQuery.data ?? [];
  const uniqueScopeCount = useMemo(
    () => new Set(grants.flatMap((grant) => grant.scopes)).size,
    [grants]
  );
  const metricsPlaceholder = grantsQuery.isLoading ? '...' : grantsQuery.isError ? '-' : null;

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
          ? grants.map((grant, index) => (
              <GrantRow key={grant.consentId} grant={grant} index={index} />
            ))
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
            <span className="account-kv-value">{metricsPlaceholder ?? grants.length}</span>
          </div>
          <div className="account-kv-row">
            <span className="account-kv-label">Unique scopes</span>
            <span className="account-kv-value">{metricsPlaceholder ?? uniqueScopeCount}</span>
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
