import { useQuery } from '@tanstack/react-query';
import { createLazyFileRoute, Link } from '@tanstack/react-router';
import { isSyntheticEmail } from '@yucp/shared/crypto';
import { useMutation as useConvexMutation, useQuery as useConvexQuery } from 'convex/react';
import { type CSSProperties, useState } from 'react';
import { AccountPage, AccountSectionCard } from '@/components/account/AccountPage';
import { AccountProfileSkeleton } from '@/components/account/AccountProfileSkeleton';
import { CreatorIdentitySettingsCard } from '@/components/account/CreatorIdentitySettingsCard';
import { Icon } from '@/components/ui/Icon';
import { ProviderChip } from '@/components/ui/ProviderChip';
import { StatusChip } from '@/components/ui/StatusChip';
import { useToast } from '@/components/ui/Toast';
import { YucpButton } from '@/components/ui/YucpButton';
import { useAccountShell } from '@/hooks/useAccountShell';
import {
  activateCreatorAccount,
  CreatorAccountSessionExpiredError,
  listUserLicenses,
  listUserOAuthGrants,
} from '@/lib/account';
import { authClient } from '@/lib/auth-client';
import { listCreatorCertificates } from '@/lib/certificates';
import { getUserAccountsQueryKey, listUserAccounts } from '@/lib/dashboard';
import { api } from '../../../../../../convex/_generated/api';

function AccountProfilePending() {
  return <AccountProfileSkeleton />;
}

export const Route = createLazyFileRoute('/_authenticated/account/')({
  pendingComponent: AccountProfilePending,
  component: AccountProfile,
});

function AccountProfile() {
  const navigate = Route.useNavigate();
  const { creatorAccount, viewer } = useAccountShell();
  const toast = useToast();
  const isCreator = creatorAccount.isActive;
  const [isActivatingCreatorAccount, setIsActivatingCreatorAccount] = useState(false);
  const [isDismissingRecoveryPrompt, setIsDismissingRecoveryPrompt] = useState(false);
  const securityOverview = useConvexQuery(api.accountSecurity.getSecurityOverview, {});
  const dismissRecoveryPrompt = useConvexMutation(api.accountSecurity.dismissRecoveryPrompt);
  const sessionQuery = useQuery({
    queryKey: ['better-auth-session'],
    queryFn: async () => {
      const result = await authClient.getSession();
      return result.data ?? null;
    },
    staleTime: 60_000,
  });
  const accountsQuery = useQuery({
    queryKey: getUserAccountsQueryKey(),
    queryFn: listUserAccounts,
  });
  const licensesQuery = useQuery({
    queryKey: ['user-licenses'],
    queryFn: listUserLicenses,
  });
  useQuery({
    queryKey: ['creator-certificates'],
    queryFn: listCreatorCertificates,
    enabled: isCreator,
  });
  const grantsQuery = useQuery({
    queryKey: ['user-oauth-grants'],
    queryFn: listUserOAuthGrants,
  });

  const sessionUser = sessionQuery.data?.user;
  const rawEmail = sessionUser?.email ?? viewer.email ?? null;
  const email = rawEmail && !isSyntheticEmail(rawEmail) ? rawEmail : null;
  const displayName = sessionUser?.name ?? viewer.name ?? email ?? 'Discord account';
  const avatarUrl = sessionUser?.image ?? viewer.image ?? null;
  const accounts = accountsQuery.data ?? [];
  const licenses = licensesQuery.data ?? [];
  const entitlements = licenses.flatMap((subject) => subject.entitlements);
  const activeLicenses = entitlements.filter(
    (entitlement) => entitlement.status === 'active'
  ).length;
  const authorizedApps = grantsQuery.data;
  const connectedLabels = accounts
    .map((connection, index) => {
      const label = connection.label || connection.provider;
      if (!label) {
        return null;
      }
      return {
        key: connection.id || `${connection.provider}-${index}`,
        label,
      };
    })
    .filter((entry): entry is { key: string; label: string } => entry !== null)
    .filter((entry, index, arr) => arr.findIndex((e) => e.label === entry.label) === index)
    .slice(0, 3);

  const renderMetricValue = (query: { isLoading: boolean; isError: boolean }, value: number) => {
    if (query.isLoading) {
      return '...';
    }
    if (query.isError) {
      return '-';
    }
    return value;
  };

  return (
    <AccountPage>
      <AccountSectionCard
        className="bento-col-8 animate-in animate-in-delay-1"
        eyebrow="Profile"
        title="Discord identity"
        description="This is the identity used across verification, licenses, and authorized apps."
      >
        <div className="account-profile-hero">
          <div className="account-avatar account-avatar--hero" aria-hidden="true">
            {avatarUrl ? (
              <img src={avatarUrl} alt={displayName} />
            ) : (
              <Icon name="profile" size={28} />
            )}
          </div>
          <div className="account-profile-hero-copy">
            <p className="account-profile-name">{displayName}</p>
            {email ? <p className="account-profile-meta">{email}</p> : null}
          </div>
        </div>

        <div className="account-pill-row">
          <StatusChip status="connected" label="Discord linked" />
          <ProviderChip name={isCreator ? 'Creator Identity' : 'Personal account'} />
          {accountsQuery.isSuccess &&
            connectedLabels.map(({ key, label }, index) => (
              <ProviderChip
                key={key}
                name={label}
                className="account-pill-chip-enter"
                style={
                  {
                    '--account-pill-enter-delay': `${Math.min(index, 5) * 55}ms`,
                  } as CSSProperties
                }
              />
            ))}
        </div>
      </AccountSectionCard>

      <AccountSectionCard
        className="bento-col-4 animate-in animate-in-delay-2 account-session-card"
        leading={<Icon name="key" aria-hidden />}
        eyebrow="Session"
        title="Your access"
        description="How you sign in and what this account can use."
        bodyClassName="account-session-card-body"
      >
        <dl className="account-session-dl">
          <div className="account-session-stat">
            <dt>Sign-in</dt>
            <dd>Discord SSO</dd>
          </div>
          <div className="account-session-stat">
            <dt>Creator dashboard</dt>
            <dd>{isCreator ? 'On' : 'Off'}</dd>
          </div>
          <div className="account-session-stat">
            <dt>Authorized apps</dt>
            <dd>{renderMetricValue(grantsQuery, authorizedApps?.length ?? 0)}</dd>
          </div>
          <div className="account-session-stat">
            <dt>Providers</dt>
            <dd>{renderMetricValue(accountsQuery, accounts.length)}</dd>
          </div>
          <div className="account-session-stat">
            <dt>Active licenses</dt>
            <dd>{renderMetricValue(licensesQuery, activeLicenses)}</dd>
          </div>
        </dl>

        <div className="account-session-footer">
          <Link to="/account/connections" className="account-btn account-btn--secondary">
            Connections
          </Link>
        </div>
      </AccountSectionCard>

      {isCreator ? <CreatorIdentitySettingsCard /> : null}

      <AccountSectionCard
        className="bento-col-12 animate-in animate-in-delay-2"
        leading={<Icon name="shield" aria-hidden />}
        eyebrow="Account recovery"
        title="Can you get back in if Discord breaks?"
        description="Discord is your usual sign-in. Add a backup method in case you lose access."
        actions={
          <Link to="/account/security" className="account-btn account-btn--primary">
            Manage recovery
          </Link>
        }
      >
        {securityOverview === undefined ? (
          <div className="account-status-banner">
            <div className="account-status-banner-copy">
              <strong>Checking your recovery options</strong>
              <span className="account-status-banner-detail">
                Loading your current passkeys, backup codes, and recovery inboxes.
              </span>
            </div>
          </div>
        ) : securityOverview.shouldShowPrompt ? (
          <div className="account-status-banner account-status-banner--warning account-status-banner--recovery-cta">
            <div className="account-status-banner-main">
              <span className="account-status-banner-icon" aria-hidden>
                <Icon name="alert" />
              </span>
              <div className="account-status-banner-copy">
                <strong>Add a backup sign-in method</strong>
                <span className="account-status-banner-detail">
                  {isCreator
                    ? 'Keep at least one option besides your Discord email alone.'
                    : 'Passkeys, backup codes, or a recovery email take a few minutes.'}
                </span>
              </div>
            </div>
            <div className="account-status-banner-actions">
              <Link to="/account/security" className="account-btn account-btn--primary">
                Set up in security
              </Link>
              {/* Synthetic-email users with zero factors can't dismiss: Discord
                  is their only door and the server rejects the dismissal. Use
                  the posture's primaryEmail — the same value the server checks. */}
              {!(
                securityOverview.primaryEmail &&
                isSyntheticEmail(securityOverview.primaryEmail) &&
                securityOverview.strongFactorCount === 0
              ) && (
                <YucpButton
                  yucp="secondary"
                  isLoading={isDismissingRecoveryPrompt}
                  onPress={async () => {
                    setIsDismissingRecoveryPrompt(true);
                    try {
                      await dismissRecoveryPrompt({});
                    } catch (error) {
                      toast.error('We couldn’t dismiss the reminder', {
                        description: error instanceof Error ? error.message : 'Try again.',
                      });
                    } finally {
                      setIsDismissingRecoveryPrompt(false);
                    }
                  }}
                >
                  Remind me later
                </YucpButton>
              )}
            </div>
          </div>
        ) : (
          <div className="account-status-banner account-status-banner--success">
            <div className="account-status-banner-copy">
              <strong>Recovery options are set up</strong>
              <span className="account-status-banner-detail">
                {`${securityOverview.strongFactorCount} backup option${securityOverview.strongFactorCount === 1 ? '' : 's'} ready to use.`}
              </span>
            </div>
          </div>
        )}

        <ul className="account-recovery-metrics" aria-label="Recovery snapshot">
          <li className="account-recovery-metric">
            <span>Passkeys</span>
            <span className="account-recovery-metric-value">
              {securityOverview?.passkeyCount ?? '...'}
            </span>
          </li>
          <li className="account-recovery-metric">
            <span>Backup codes</span>
            <span className="account-recovery-metric-value">
              {securityOverview?.backupCodeCount ?? '...'}
            </span>
          </li>
          <li className="account-recovery-metric">
            <span>Recovery inboxes</span>
            <span className="account-recovery-metric-value">
              {securityOverview?.verifiedRecoveryEmailCount ?? '...'}
            </span>
          </li>
          <li className="account-recovery-metric account-recovery-metric--policy">
            <span>Primary email reset</span>
            <span className="account-recovery-metric-value">
              {securityOverview?.primaryEmailRecoveryEligible ? 'On' : 'Paused'}
            </span>
          </li>
        </ul>
      </AccountSectionCard>

      <AccountSectionCard
        id="creator-account"
        className="bento-col-12 animate-in animate-in-delay-2"
        eyebrow={isCreator ? 'Creator mode' : 'Get started'}
        title={isCreator ? 'Your Creator Identity is active' : 'Create your Creator Identity'}
        description={
          isCreator
            ? 'Switch from account controls into your Creator Identity whenever you want.'
            : 'Turn on your creator workspace now. You can connect a Discord server later if you want role automation.'
        }
      >
        <p className="account-feature-copy">
          {isCreator
            ? 'Use the creator dashboard to connect stores, manage products, collaborate, and build your community.'
            : 'This creates your Creator Account and opens the dashboard.'}
        </p>

        <div className="account-inline-actions">
          {isCreator ? (
            <YucpButton yucp="primary" onPress={() => void navigate({ to: '/dashboard' })}>
              Open creator dashboard
            </YucpButton>
          ) : (
            <YucpButton
              yucp="primary"
              isLoading={isActivatingCreatorAccount}
              onPress={async () => {
                setIsActivatingCreatorAccount(true);
                try {
                  await activateCreatorAccount();
                  window.location.assign('/dashboard');
                } catch (error) {
                  if (error instanceof CreatorAccountSessionExpiredError) {
                    setIsActivatingCreatorAccount(false);
                    await navigate({
                      to: '/sign-in',
                      search: {
                        redirectTo: '/account#creator-account',
                      },
                    });
                    return;
                  }
                  toast.error('We couldn’t create your Creator Account', {
                    description: error instanceof Error ? error.message : 'Try again.',
                  });
                  setIsActivatingCreatorAccount(false);
                }
              }}
            >
              Become a creator
            </YucpButton>
          )}
          {isCreator ? (
            <YucpButton yucp="secondary" onPress={() => void navigate({ to: '/account/billing' })}>
              Manage billing
            </YucpButton>
          ) : null}
        </div>
      </AccountSectionCard>
    </AccountPage>
  );
}
