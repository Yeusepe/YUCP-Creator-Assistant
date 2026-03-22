import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { AccountPage, AccountSectionCard } from '@/components/account/AccountPage';
import { useAccountShell } from '@/hooks/useAccountShell';
import { useAuth } from '@/hooks/useAuth';
import { listUserLicenses, listUserOAuthGrants } from '@/lib/account';
import { authClient } from '@/lib/auth-client';
import { listUserAccounts, listUserProviders } from '@/lib/dashboard';

export const Route = createFileRoute('/account/')({
  component: AccountProfile,
});

function AccountProfile() {
  const { guilds, viewer } = useAccountShell();
  const { signOut } = useAuth();
  const sessionQuery = useQuery({
    queryKey: ['better-auth-session'],
    queryFn: async () => {
      const result = await authClient.getSession();
      return result.data ?? null;
    },
    staleTime: 60_000,
  });
  const providersQuery = useQuery({
    queryKey: ['user-providers'],
    queryFn: listUserProviders,
  });
  const accountsQuery = useQuery({
    queryKey: ['user-accounts'],
    queryFn: listUserAccounts,
  });
  const licensesQuery = useQuery({
    queryKey: ['user-licenses'],
    queryFn: listUserLicenses,
  });
  const grantsQuery = useQuery({
    queryKey: ['user-oauth-grants'],
    queryFn: listUserOAuthGrants,
  });

  const isCreator = guilds.length > 0;
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
  const authorizedApps = grantsQuery.data ?? [];
  const availableProviders = providersQuery.data ?? [];
  const connectedLabels = accounts
    .map((connection) => connection.label || connection.provider)
    .filter(Boolean)
    .slice(0, 3);
  const workspaceHref = viewer.authUserId
    ? `/api/install/bot?authUserId=${encodeURIComponent(viewer.authUserId)}`
    : undefined;

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
          <span className="account-badge account-badge--connected">Discord linked</span>
          <span className="account-badge account-badge--provider">
            {isCreator ? 'Creator account' : 'Personal account'}
          </span>
          {connectedLabels.map((label) => (
            <span key={label} className="account-badge account-badge--provider">
              {label}
            </span>
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
            <span className="account-kv-value">{authorizedApps.length}</span>
          </div>
          <div className="account-kv-row">
            <span className="account-kv-label">Connected providers</span>
            <span className="account-kv-value">
              {accountsQuery.isLoading ? '...' : accounts.length}
            </span>
          </div>
          <div className="account-kv-row">
            <span className="account-kv-label">Active licenses</span>
            <span className="account-kv-value">
              {licensesQuery.isLoading ? '...' : activeLicenses}
            </span>
          </div>
          <div className="account-kv-row">
            <span className="account-kv-label">Available providers</span>
            <span className="account-kv-value">
              {providersQuery.isLoading ? '...' : availableProviders.length}
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
        className="bento-col-7 animate-in animate-in-delay-2"
        eyebrow="Shortcuts"
        title="Jump into the right tool"
        description="The same account shell now powers every part of your personal workspace."
      >
        <div className="account-shortcut-grid">
          <Link to="/account/connections" className="account-shortcut-card">
            <span className="account-shortcut-title">Connected Accounts</span>
            <span className="account-shortcut-desc">
              Link storefronts and identity providers used during verification.
            </span>
          </Link>
          <Link to="/account/licenses" className="account-shortcut-card">
            <span className="account-shortcut-title">Verified Purchases</span>
            <span className="account-shortcut-desc">
              Review active access and deactivate licenses when needed.
            </span>
          </Link>
          <Link to="/account/authorized-apps" className="account-shortcut-card">
            <span className="account-shortcut-title">Authorized Apps</span>
            <span className="account-shortcut-desc">
              Audit which OAuth apps can act on your account.
            </span>
          </Link>
          <Link to="/account/privacy" className="account-shortcut-card">
            <span className="account-shortcut-title">Privacy & Data</span>
            <span className="account-shortcut-desc">
              Export data, review rights, and manage deletion requests.
            </span>
          </Link>
        </div>
      </AccountSectionCard>

      <AccountSectionCard
        className="bento-col-5 animate-in animate-in-delay-3"
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

        {isCreator ? (
          <a href="/dashboard" className="account-btn account-btn--primary">
            Open creator dashboard
          </a>
        ) : workspaceHref ? (
          <a href={workspaceHref} className="account-btn account-btn--primary">
            Add bot to a server
          </a>
        ) : null}
      </AccountSectionCard>
    </AccountPage>
  );
}
