import { useQuery } from '@tanstack/react-query';
import { createLazyFileRoute, Link } from '@tanstack/react-router';
import { AccountPage, AccountSectionCard } from '@/components/account/AccountPage';
import { DashboardListSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { ProviderChip } from '@/components/ui/ProviderChip';
import { StatusChip } from '@/components/ui/StatusChip';
import { useAccountShell } from '@/hooks/useAccountShell';
import { useAuth } from '@/hooks/useAuth';
import { listUserLicenses, listUserOAuthGrants } from '@/lib/account';
import { authClient } from '@/lib/auth-client';
import { listCreatorCertificates } from '@/lib/certificates';
import { listUserAccounts } from '@/lib/dashboard';

function AccountProfilePending() {
  return (
    <AccountPage>
      <DashboardListSkeleton rows={4} />
    </AccountPage>
  );
}

export const Route = createLazyFileRoute('/_authenticated/account/')({
  pendingComponent: AccountProfilePending,
  component: AccountProfile,
});

function AccountProfile() {
  const { guilds, viewer } = useAccountShell();
  const { signOut } = useAuth();
  const isCreator = guilds.length > 0;
  const sessionQuery = useQuery({
    queryKey: ['better-auth-session'],
    queryFn: async () => {
      const result = await authClient.getSession();
      return result.data ?? null;
    },
    staleTime: 60_000,
  });
  const accountsQuery = useQuery({
    queryKey: ['user-accounts'],
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
          <ProviderChip name={isCreator ? 'Creator account' : 'Personal account'} />
          {connectedLabels.map(({ key, label }) => (
            <ProviderChip key={key} name={label} />
          ))}
        </div>
      </AccountSectionCard>

      <AccountSectionCard
        className="bento-col-4 animate-in animate-in-delay-2"
        eyebrow="Session"
        title="Access and security"
        description="Quick visibility into how you are signed in and what your account can access."
        actions={
          <Link to="/account/connections" className="account-btn account-btn--secondary">
            Manage connections
          </Link>
        }
      >
        <div className="account-kv-list">
          <div className="account-kv-row">
            <span className="account-kv-label">Authentication</span>
            <span className="account-kv-value">Discord SSO</span>
          </div>
          <div className="account-kv-row">
            <span className="account-kv-label">Creator dashboard</span>
            <span className="account-kv-value">{isCreator ? 'Enabled' : 'Not enabled'}</span>
          </div>
          <div className="account-kv-row">
            <span className="account-kv-label">Authorized apps</span>
            <span className="account-kv-value">
              {renderMetricValue(grantsQuery, authorizedApps?.length ?? 0)}
            </span>
          </div>
          <div className="account-kv-row">
            <span className="account-kv-label">Connected providers</span>
            <span className="account-kv-value">
              {renderMetricValue(accountsQuery, accounts.length)}
            </span>
          </div>
          <div className="account-kv-row">
            <span className="account-kv-label">Active licenses</span>
            <span className="account-kv-value">
              {renderMetricValue(licensesQuery, activeLicenses)}
            </span>
          </div>
        </div>

        <button
          type="button"
          className="account-btn account-btn--secondary"
          onClick={() => signOut()}
        >
          Sign out
        </button>
      </AccountSectionCard>

      <AccountSectionCard
        className="bento-col-12 animate-in animate-in-delay-2"
        eyebrow={isCreator ? 'Creator mode' : 'Get started'}
        title={isCreator ? 'Your creator workspace is ready' : 'Unlock the creator dashboard'}
        description={
          isCreator
            ? 'Switch from account controls into your creator workspace whenever you want.'
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
