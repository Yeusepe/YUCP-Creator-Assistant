import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { type CSSProperties, useState } from 'react';
import {
  AccountEmptyState,
  AccountInlineError,
  AccountPage,
  AccountSectionCard,
} from '@/components/account/AccountPage';
import { DashboardListSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { useToast } from '@/components/ui/Toast';
import {
  disconnectUserAccount,
  listUserAccounts,
  listUserProviders,
  startUserVerify,
  type UserAccountConnection,
  type UserProvider,
  type UserProviderDisplay,
} from '@/lib/dashboard';

function AccountConnectionsPending() {
  return (
    <AccountPage>
      <DashboardListSkeleton rows={3} />
    </AccountPage>
  );
}

interface ProviderCardModel extends UserProviderDisplay {
  canConnect: boolean;
}

function buildProviderCardModel(connection: UserAccountConnection): ProviderCardModel {
  const display = connection.providerDisplay;

  return {
    id: connection.provider,
    label: display?.label ?? connection.provider,
    icon: display?.icon ?? null,
    color: display?.color ?? null,
    description: display?.description ?? connection.label ?? null,
    canConnect: false,
  };
}

function buildProviderCards(
  providers: UserProvider[],
  connections: UserAccountConnection[]
): ProviderCardModel[] {
  const cards = new Map<string, ProviderCardModel>();

  for (const provider of providers) {
    cards.set(provider.id, {
      ...provider,
      canConnect: true,
    });
  }

  for (const connection of connections) {
    const fallback = buildProviderCardModel(connection);
    const existing = cards.get(connection.provider);
    if (!existing) {
      cards.set(connection.provider, fallback);
      continue;
    }

    cards.set(connection.provider, {
      ...existing,
      icon: existing.icon ?? fallback.icon,
      color: existing.color ?? fallback.color,
      description: existing.description ?? fallback.description,
    });
  }

  return Array.from(cards.values());
}

export const Route = createFileRoute('/account/connections')({
  pendingComponent: AccountConnectionsPending,
  component: AccountConnections,
});

function ProviderCard({
  provider,
  connections,
}: Readonly<{
  provider: ProviderCardModel;
  connections: UserAccountConnection[];
}>) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const queryClient = useQueryClient();
  const toast = useToast();

  const disconnectMut = useMutation({
    mutationFn: (id: string) => disconnectUserAccount(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-accounts'] });
      setConfirmingId(null);
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

  const providerColor = provider.color ?? '#64748b';
  const providerDescription = provider.description ?? 'Linked provider';
  const iconStyle: CSSProperties = {
    backgroundColor: `${providerColor}20`,
  };
  const isConnected = connections.length > 0;

  return (
    <div className="acct-provider-card">
      <div className="acct-provider-icon" style={iconStyle} aria-hidden="true">
        {provider.icon ? (
          <img
            src={`/Icons/${provider.icon}`}
            alt={provider.label}
            style={{ borderRadius: '4px' }}
          />
        ) : (
          <span>{provider.label.slice(0, 1).toUpperCase()}</span>
        )}
      </div>

      <div className="acct-provider-info">
        <div className="acct-provider-title-row">
          <p className="acct-provider-name">{provider.label}</p>
          {isConnected ? (
            <span className="account-badge account-badge--connected">Connected</span>
          ) : null}
          {connections.length > 1 ? (
            <span className="account-badge account-badge--provider">
              {connections.length} links
            </span>
          ) : null}
        </div>
        {isConnected ? (
          <div className="acct-provider-connection-list">
            {connections.map((connection) => {
              const isConfirming = confirmingId === connection.id;
              return (
                <div key={connection.id} className="acct-provider-connection-row">
                  <div className="acct-provider-connection-copy">
                    <p className="acct-provider-meta">
                      {connection.providerUsername ||
                        connection.providerUserId ||
                        connection.label ||
                        provider.description}
                    </p>
                    <div className="account-pill-row account-pill-row--compact">
                      <span className="account-badge account-badge--provider">
                        {connection.connectionType}
                      </span>
                      <span className="account-badge account-badge--provider">
                        {connection.status}
                      </span>
                      {connection.verificationMethod ? (
                        <span className="account-badge account-badge--provider">
                          {connection.verificationMethod}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="acct-provider-actions">
                    {isConfirming ? (
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
                          onClick={() => setConfirmingId(null)}
                          disabled={disconnectMut.isPending}
                        >
                          No
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="account-btn account-btn--danger"
                        onClick={() => setConfirmingId(connection.id)}
                      >
                        Disconnect
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="acct-provider-meta">{providerDescription}</p>
        )}
      </div>

      {!isConnected && provider.canConnect ? (
        <div className="acct-provider-actions">
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
        </div>
      ) : null}
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
  const connectableProviders = providersQuery.data ?? [];
  const connections = accountsQuery.data ?? [];
  const providers = buildProviderCards(connectableProviders, connections);
  const connectionsByProvider = new Map<string, UserAccountConnection[]>();
  for (const connection of connections) {
    const providerConnections = connectionsByProvider.get(connection.provider) ?? [];
    providerConnections.push(connection);
    connectionsByProvider.set(connection.provider, providerConnections);
  }
  const connectedCount = connections.length;
  const activeLinkCount = connections.filter((connection) => connection.status === 'active').length;
  const expiredLinkCount = connections.filter(
    (connection) => connection.status === 'expired'
  ).length;

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
                connections={connectionsByProvider.get(provider.id) ?? []}
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
              {providersQuery.isLoading ? '...' : connectableProviders.length}
            </span>
          </div>
          <div className="account-kv-row">
            <span className="account-kv-label">Active links</span>
            <span className="account-kv-value">
              {accountsQuery.isLoading ? '...' : activeLinkCount}
            </span>
          </div>
          <div className="account-kv-row">
            <span className="account-kv-label">Expired links</span>
            <span className="account-kv-value">
              {accountsQuery.isLoading ? '...' : expiredLinkCount}
            </span>
          </div>
        </div>

        <div className="account-note-stack">
          <p className="account-feature-copy">
            Linked accounts are used only when a provider flow needs them. Disconnecting a provider
            does not delete your licenses or revoke unrelated app authorizations.
          </p>
          <p className="account-feature-copy">
            If a linked account expires or is revoked upstream, reconnect it here before retrying a
            hosted verification flow.
          </p>
        </div>
      </AccountSectionCard>
    </AccountPage>
  );
}
