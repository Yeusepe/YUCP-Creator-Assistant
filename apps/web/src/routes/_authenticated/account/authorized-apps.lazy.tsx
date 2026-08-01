import { Tooltip } from '@heroui/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createLazyFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { AccountEntityCard } from '@/components/account/AccountEntityCard';
import {
  AccountEmptyState,
  AccountInlineError,
  AccountModal,
  AccountPage,
  AccountSectionCard,
} from '@/components/account/AccountPage';
import { DashboardListSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { Icon } from '@/components/ui/Icon';
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
  const isNativeApplication = grant.platform === 'native';
  const actionLabel = isNativeApplication ? 'Sign out' : 'Revoke';
  const actionPendingLabel = isNativeApplication ? 'Signing out...' : 'Revoking...';
  const modalTitle = isNativeApplication
    ? `Sign out of ${grant.appName}?`
    : `Revoke ${grant.appName}?`;

  const revokeMut = useMutation({
    mutationFn: () => revokeUserOAuthGrant(grant.consentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: USER_OAUTH_GRANTS_QUERY_KEY });
      setConfirming(false);
      toast.success(isNativeApplication ? 'Application signed out' : 'App access revoked', {
        description: `${grant.appName} must be authorized again before it can use your account.`,
      });
    },
    onError: () => {
      toast.error(
        isNativeApplication ? 'We couldn’t sign this app out' : 'We couldn’t revoke app access',
        {
          description: `Try ${isNativeApplication ? 'signing out of' : 'revoking'} ${grant.appName} again.`,
        }
      );
    },
  });

  const appInitial = grant.appName.slice(0, 1).toUpperCase();
  const clientPreview =
    grant.clientId.length > 18
      ? `${grant.clientId.slice(0, 8)}\u2026${grant.clientId.slice(-6)}`
      : grant.clientId;

  return (
    <AccountEntityCard index={index}>
      <div className="account-entity-layout">
        <div className="account-entity-leading account-app-icon" aria-hidden="true">
          <span className="account-app-icon-letter">{appInitial}</span>
        </div>

        <div className="account-entity-body">
          <p className="account-entity-kicker">Connected app</p>
          <h3 className="account-entity-title">{grant.appName}</h3>
          <dl className="account-entity-dl">
            <div className="account-entity-dl-row">
              <dt>App ID</dt>
              <dd>
                <Tooltip>
                  <button
                    type="button"
                    className="account-reference-chip"
                    style={{ cursor: 'help' }}
                    aria-label={grant.clientId}
                  >
                    {clientPreview}
                  </button>
                  <Tooltip.Content>
                    <p className="account-tooltip-mono">{grant.clientId}</p>
                  </Tooltip.Content>
                </Tooltip>
              </dd>
            </div>
            {grant.grantedAt ? (
              <div className="account-entity-dl-row">
                <dt>Authorized</dt>
                <dd>{formatAccountDate(grant.grantedAt)}</dd>
              </div>
            ) : null}
          </dl>
          {grant.scopes.length > 0 ? (
            <div className="account-entity-scopes">
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

        <div className="account-entity-aside">
          {!confirming ? (
            <YucpButton yucp="ghost" onClick={() => setConfirming(true)}>
              {actionLabel}
            </YucpButton>
          ) : null}
        </div>
      </div>

      {confirming ? (
        <AccountModal title={modalTitle} onClose={() => setConfirming(false)}>
          <p className="account-modal-body">
            {isNativeApplication
              ? 'Signing out revokes this application’s saved Creator Account session. It must sign in again before it can use your account.'
              : 'Revoking access stops this app from using your Creator Account. It will need your permission to connect again.'}
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
              {revokeMut.isPending ? actionPendingLabel : actionLabel}
            </YucpButton>
          </div>
        </AccountModal>
      ) : null}
    </AccountEntityCard>
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
          <AccountInlineError message="We couldn’t load authorized apps. Refresh to try again." />
        ) : null}

        {!grantsQuery.isLoading && !grantsQuery.isError && grants.length === 0 ? (
          <AccountEmptyState
            icon={<Icon name="star" size={20} />}
            title="No authorized apps"
            description="Apps you authorize with your account will appear here. You can revoke access at any time."
          />
        ) : null}

        {!grantsQuery.isLoading && !grantsQuery.isError && grants.length > 0 ? (
          <div className="account-entity-list">
            {grants.map((grant, index) => (
              <GrantRow key={grant.consentId} grant={grant} index={index} />
            ))}
          </div>
        ) : null}
      </AccountSectionCard>

      <AccountSectionCard
        className="bento-col-4 animate-in animate-in-delay-2"
        eyebrow="Security"
        title="What revocation means"
        description="Revoking access takes effect immediately. The app must ask for permission again before it can reconnect."
      >
        <div className="account-kv-list">
          <div className="account-kv-row">
            <span className="account-kv-label">Connected apps</span>
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
