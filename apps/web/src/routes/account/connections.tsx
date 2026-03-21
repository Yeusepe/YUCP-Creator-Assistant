import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
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
  onDisconnected,
}: {
  provider: UserProvider;
  connection: UserAccountConnection | undefined;
  onDisconnected: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const queryClient = useQueryClient();

  const disconnectMut = useMutation({
    mutationFn: (id: string) => disconnectUserAccount(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ['user-accounts'] });
      setConfirming(false);
      onDisconnected(id);
    },
  });

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const { redirectUrl } = await startUserVerify(provider.id);
      window.location.href = redirectUrl;
    } catch {
      setConnecting(false);
    }
  };

  const iconStyle = {
    backgroundColor: `${provider.color}20`,
  };

  return (
    <div className="acct-provider-card">
      <div className="acct-provider-icon" style={iconStyle} aria-hidden="true">
        <img src={`/Icons/${provider.icon}`} alt={provider.label} style={{ borderRadius: '4px' }} />
      </div>

      <div className="acct-provider-info">
        <p className="acct-provider-name">{provider.label}</p>
        <p className="acct-provider-meta">
          {connection ? (
            <>
              <span className="account-badge account-badge--connected">Connected</span>
              {connection.label && <span style={{ marginLeft: '4px' }}>{connection.label}</span>}
            </>
          ) : (
            provider.description
          )}
        </p>
      </div>

      <div className="acct-provider-actions">
        {connection ? (
          confirming ? (
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <span style={{ fontSize: '12px', color: '#888', whiteSpace: 'nowrap' }}>
                Disconnect?
              </span>
              <button
                type="button"
                className={`account-btn account-btn--danger${disconnectMut.isPending ? ' btn-loading' : ''}`}
                style={{ fontSize: '12px', padding: '4px 10px', borderRadius: '8px' }}
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
                style={{ fontSize: '12px', padding: '4px 10px', borderRadius: '8px' }}
                onClick={() => setConfirming(false)}
              >
                No
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="account-btn account-btn--danger"
              style={{ fontSize: '12px', padding: '5px 10px', borderRadius: '8px' }}
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
  const queryClient = useQueryClient();

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
    connections.map((c) => [c.provider, c])
  );

  const handleDisconnected = (_id: string) => {
    queryClient.invalidateQueries({ queryKey: ['user-accounts'] });
  };

  return (
    <section className="account-section">
      <div className="account-section-header">
        <h2 className="account-section-title">Connected Accounts</h2>
        <p className="account-section-desc">
          Link your platform accounts for seamless verification across servers.
        </p>
      </div>
      <div className="account-section-body">
        {isLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div className="account-skeleton-row" />
            <div className="account-skeleton-row" style={{ width: '80%' }} />
            <div className="account-skeleton-row" style={{ width: '60%' }} />
          </div>
        ) : providers.length === 0 ? (
          <div className="account-empty">
            <div className="account-empty-icon" aria-hidden="true">
              <svg
                aria-hidden="true"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
            </div>
            <p className="account-empty-title">No providers available</p>
            <p className="account-empty-desc">Check back later for available integrations.</p>
          </div>
        ) : (
          <div className="acct-provider-grid">
            {providers.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                connection={connectionsByProvider.get(provider.id)}
                onDisconnected={handleDisconnected}
              />
            ))}
          </div>
        )}

        {(providersQuery.isError || accountsQuery.isError) && (
          <p style={{ fontSize: '13px', color: '#dc2626', margin: 0 }}>
            Failed to load connections. Refresh to try again.
          </p>
        )}
      </div>
    </section>
  );
}
