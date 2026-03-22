import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { type CSSProperties, useState } from 'react';
import {
  AccountEmptyState,
  AccountInlineError,
  AccountPage,
  AccountSectionCard,
} from '@/components/account/AccountPage';
import { useToast } from '@/components/ui/Toast';
import {
  disconnectUserAccount,
  listUserAccounts,
  listUserProviders,
  startUserVerify,
  type UserAccountConnection,
  type UserProvider,
} from '@/lib/dashboard';

export const Route = createFileRoute('/account/connections')({
  component: AccountConnections,
});

function ProviderCard({
  provider,
  connection,
}: Readonly<{
  provider: UserProvider;
  connection: UserAccountConnection | undefined;
}>) {
  const [confirming, setConfirming] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const queryClient = useQueryClient();
  const toast = useToast();

  const disconnectMut = useMutation({
    mutationFn: (id: string) => disconnectUserAccount(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-accounts'] });
      setConfirming(false);
      toast.success('Account disconnected', {
        description: `${provider.label} will no longer be used for account verification.`,
      });
    },
    onError: () => {
      toast.error('Could not disconnect account', {
        description: `Please try disconnecting ${provider.label} again.`,
      });
    },
  });

  const handleConnect = async () => {
    setConnecting(true);

    try {
      const { redirectUrl } = await startUserVerify(provider.id);
      window.location.href = redirectUrl;
    } catch {
      setConnecting(false);
      toast.error('Could not start connection', {
        description: `Please try connecting ${provider.label} again.`,
      });
    }
  };

  const iconStyle: CSSProperties = {
    backgroundColor: `${provider.color}20`,
  };

  return (
    <div className="acct-provider-card">
      <div className="acct-provider-icon" style={iconStyle} aria-hidden="true">
        <img src={`/Icons/${provider.icon}`} alt={provider.label} style={{ borderRadius: '4px' }} />
      </div>

      <div className="acct-provider-info">
        <div className="acct-provider-title-row">
          <p className="acct-provider-name">{provider.label}</p>
          {connection ? (
            <span className="account-badge account-badge--connected">Connected</span>
          ) : null}
        </div>
        <p className="acct-provider-meta">{connection?.label ?? provider.description}</p>
        {connection ? (
          <div className="account-pill-row account-pill-row--compact">
            <span className="account-badge account-badge--provider">
              {connection.connectionType}
            </span>
            <span className="account-badge account-badge--provider">{connection.status}</span>
            {connection.webhookConfigured ? (
              <span className="account-badge account-badge--connected">Webhook ready</span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="acct-provider-actions">
        {connection ? (
          confirming ? (
            <div className="account-inline-actions">
              <span className="account-field-note">Disconnect?</span>
              <button
                type="button"
                className={`account-btn account-btn--danger${disconnectMut.isPending ? ' btn-loading' : ''}`}
                onClick={() => disconnectMut.mutate(connection.id)}
                disabled={disconnectMut.isPending}
              >
                {disconnectMut.isPending ? (
                  <>
                    <span className="btn-loading-spinner" aria-hidden="true" />
                    Disconnecting...
                  </>
                ) : (
                  'Yes'
                )}
              </button>
              <button
                type="button"
                className="account-btn account-btn--secondary"
                onClick={() => setConfirming(false)}
                disabled={disconnectMut.isPending}
              >
                No
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="account-btn account-btn--danger"
              onClick={() => setConfirming(true)}
            >
              Disconnect
            </button>
          )
        ) : (
          <button
            type="button"
            className={`account-btn account-btn--connect${connecting ? ' btn-loading' : ''}`}
            onClick={handleConnect}
            disabled={connecting}
          >
            {connecting ? (
              <>
                <span className="btn-loading-spinner" aria-hidden="true" />
                Connecting...
              </>
            ) : (
              'Connect'
            )}
          </button>
        )}
      </div>
    </div>
  );
}

function AccountConnections() {
  const providersQuery = useQuery({
    queryKey: ['user-providers'],
    queryFn: listUserProviders,
  });

  const accountsQuery = useQuery({
    queryKey: ['user-accounts'],
    queryFn: listUserAccounts,
  });

  const isLoading = providersQuery.isLoading || accountsQuery.isLoading;
  const providers = providersQuery.data ?? [];
  const connections = accountsQuery.data ?? [];
  const connectionsByProvider = new Map<string, UserAccountConnection>(
    connections.map((connection) => [connection.provider, connection])
  );
  const connectedCount = connections.length;
  const webhookReadyCount = connections.filter((connection) => connection.webhookConfigured).length;

  return (
    <AccountPage>
      <AccountSectionCard
        className="bento-col-8 animate-in animate-in-delay-1"
        eyebrow="Providers"
        title="Manage linked providers"
        description="Connect only the services you actively use. Every provider can be revoked later from this same account shell."
      >
        {isLoading ? (
          <div className="account-skeleton-stack">
            <div className="account-skeleton-row" />
            <div className="account-skeleton-row" style={{ width: '82%' }} />
            <div className="account-skeleton-row" style={{ width: '68%' }} />
          </div>
        ) : providers.length === 0 ? (
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
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
            }
            title="No providers available"
            description="Check back later for account providers that support direct linking."
          />
        ) : (
          <div className="acct-provider-grid">
            {providers.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                connection={connectionsByProvider.get(provider.id)}
              />
            ))}
          </div>
        )}

        {providersQuery.isError || accountsQuery.isError ? (
          <AccountInlineError message="Failed to load account connections. Refresh to try again." />
        ) : null}
      </AccountSectionCard>

      <AccountSectionCard
        className="bento-col-4 animate-in animate-in-delay-2"
        eyebrow="Guidance"
        title="How links are used"
        description="These connections power verification flows across supported providers."
      >
        <div className="account-kv-list">
          <div className="account-kv-row">
            <span className="account-kv-label">Live connections</span>
            <span className="account-kv-value">
              {accountsQuery.isLoading ? '...' : connectedCount}
            </span>
          </div>
          <div className="account-kv-row">
            <span className="account-kv-label">Available providers</span>
            <span className="account-kv-value">
              {providersQuery.isLoading ? '...' : providers.length}
            </span>
          </div>
          <div className="account-kv-row">
            <span className="account-kv-label">Webhook ready</span>
            <span className="account-kv-value">
              {accountsQuery.isLoading ? '...' : webhookReadyCount}
            </span>
          </div>
        </div>

        <div className="account-note-stack">
          <p className="account-feature-copy">
            Linked accounts are used only when a provider flow needs them. Disconnecting a provider
            does not delete your licenses or revoke unrelated app authorizations.
          </p>
          <p className="account-feature-copy">
            If a provider returns an auth error, reconnect it here so the system can resume using
            fresh credentials.
          </p>
        </div>
      </AccountSectionCard>
    </AccountPage>
  );
}
