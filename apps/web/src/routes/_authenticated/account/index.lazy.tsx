import { useQuery } from '@tanstack/react-query';
import { createLazyFileRoute, Link } from '@tanstack/react-router';
import { useMutation as useConvexMutation, useQuery as useConvexQuery } from 'convex/react';
import { AlertCircle, KeyRound, ShieldCheck } from 'lucide-react';
import { type CSSProperties, useState } from 'react';
import { AccountPage, AccountSectionCard } from '@/components/account/AccountPage';
import { AccountProfileSkeleton } from '@/components/account/AccountProfileSkeleton';
import { ProviderChip } from '@/components/ui/ProviderChip';
import { StatusChip } from '@/components/ui/StatusChip';
import { useToast } from '@/components/ui/Toast';
import { YucpButton } from '@/components/ui/YucpButton';
import { useAccountShell } from '@/hooks/useAccountShell';
import { listUserLicenses, listUserOAuthGrants } from '@/lib/account';
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
  const { guilds, viewer } = useAccountShell();
  const toast = useToast();
  const isCreator = guilds.length > 0;
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
  const displayName =
    sessionUser?.name ?? viewer.name ?? sessionUser?.email ?? viewer.email ?? 'Discord account';
  const avatarUrl = sessionUser?.image ?? viewer.image ?? null;
  const email = sessionUser?.email ?? viewer.email ?? null;
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

  const workspaceHref = '/api/install/bot';

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
              <svg
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <circle cx="12" cy="8" r="4" />
                <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
              </svg>
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
        leading={<KeyRound strokeWidth={1.75} aria-hidden />}
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

      <AccountSectionCard
        className="bento-col-12 animate-in animate-in-delay-2"
        leading={<ShieldCheck strokeWidth={1.75} aria-hidden />}
        eyebrow="Account recovery"
        title="Can you get back in if Discord breaks?"
        description="Discord is your normal sign-in. Add backups—passkeys, one-time codes, or a spare inbox—so you are never stuck."
        actions={
          <Link to="/account/security" className="account-btn account-btn--primary">
            Manage recovery
          </Link>
        }
      >
        {securityOverview === undefined ? (
          <div className="account-status-banner">
            <div className="account-status-banner-copy">
              <strong>Checking recovery coverage</strong>
              <span className="account-status-banner-detail">
                Loading your current passkeys, backup codes, and recovery inboxes.
              </span>
            </div>
          </div>
        ) : securityOverview.shouldShowPrompt ? (
          <div className="account-status-banner account-status-banner--warning account-status-banner--recovery-cta">
            <div className="account-status-banner-main">
              <span className="account-status-banner-icon" aria-hidden>
                <AlertCircle strokeWidth={1.75} />
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
              <YucpButton
                yucp="secondary"
                isLoading={isDismissingRecoveryPrompt}
                onPress={async () => {
                  setIsDismissingRecoveryPrompt(true);
                  try {
                    await dismissRecoveryPrompt({});
                  } catch (error) {
                    toast.error('Could not dismiss reminder', {
                      description: error instanceof Error ? error.message : 'Try again.',
                    });
                  } finally {
                    setIsDismissingRecoveryPrompt(false);
                  }
                }}
              >
                Remind me later
              </YucpButton>
            </div>
          </div>
        ) : (
          <div className="account-status-banner account-status-banner--success">
            <div className="account-status-banner-copy">
              <strong>Recovery options look healthy</strong>
              <span className="account-status-banner-detail">
                {`${securityOverview.strongFactorCount} strong backup${securityOverview.strongFactorCount === 1 ? '' : 's'} on file.`}
              </span>
            </div>
          </div>
        )}

        <ul className="account-recovery-metrics" aria-label="Recovery snapshot">
          <li className="account-recovery-metric">
            <span>Passkeys</span>
            <span className="account-recovery-metric-value">
              {securityOverview?.passkeyCount ?? '—'}
            </span>
          </li>
          <li className="account-recovery-metric">
            <span>Backup codes</span>
            <span className="account-recovery-metric-value">
              {securityOverview?.backupCodeCount ?? '—'}
            </span>
          </li>
          <li className="account-recovery-metric">
            <span>Recovery inboxes</span>
            <span className="account-recovery-metric-value">
              {securityOverview?.verifiedRecoveryEmailCount ?? '—'}
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
        className="bento-col-12 animate-in animate-in-delay-2"
        eyebrow={isCreator ? 'Creator mode' : 'Get started'}
        title={isCreator ? 'Your Creator Identity is ready' : 'Unlock the creator dashboard'}
        description={
          isCreator
            ? 'Switch from account controls into your Creator Identity whenever you want.'
            : 'Invite the bot to a Discord server to unlock storefront connections, role automation, and creator-only tooling.'
        }
      >
        <p className="account-feature-copy">
          {isCreator
            ? 'Use the creator dashboard to configure storefront integrations, server policies, collaboration flows, and audit visibility for every connected community.'
            : 'Once the bot is installed on a server you manage, this account immediately gains access to the dashboard and its setup flows.'}
        </p>

        <div className="account-inline-actions">
          {isCreator ? (
            <Link to="/dashboard" className="account-btn account-btn--primary">
              Open creator dashboard
            </Link>
          ) : workspaceHref ? (
            <a href={workspaceHref} className="account-btn account-btn--primary">
              Add bot to a server
            </a>
          ) : null}
          {isCreator ? (
            <Link to="/dashboard/certificates" className="account-btn account-btn--secondary">
              Manage billing
            </Link>
          ) : null}
        </div>
      </AccountSectionCard>
    </AccountPage>
  );
}
