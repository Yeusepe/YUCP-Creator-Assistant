import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { DashboardSkeletonSwap } from '@/components/dashboard/DashboardSkeletonSwap';
import { DashboardListSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { isDashboardAuthError } from '@/hooks/useDashboardSession';
import type { UserAccountConnection } from '@/lib/dashboard';
import {
  buildProviderConnectUrl,
  getConnectionStatus,
  getProviderIconPath,
  listDashboardConnections,
  listDashboardProviders,
} from '@/lib/dashboard';
import { dashboardPanelQueryOptions } from '@/lib/dashboardQueryOptions';
import { type DashboardProvider } from '@/lib/server/dashboard';

export interface StoreIntegrationsPanelProps {
  authUserId: string | undefined;
  guildId: string | undefined;
  canRunPanelQueries: boolean;
  onAuthError?: () => void;
  onLinkedCountChange?: (count: number) => void;
}

function requireAuthUserId(authUserId: string | undefined) {
  if (!authUserId) {
    throw new Error('Not authenticated');
  }
  return authUserId;
}

type ProviderStatus = 'active' | 'degraded' | 'disconnected';

export function StoreRow({
  provider,
  account,
  authUserId,
  guildId,
}: {
  provider: DashboardProvider;
  account: UserAccountConnection | undefined;
  authUserId: string | undefined;
  guildId: string | undefined;
}) {
  const status: ProviderStatus = (account?.status as ProviderStatus) ?? 'disconnected';
  const iconPath = getProviderIconPath(provider);
  const manageHref = buildProviderConnectUrl(provider, { authUserId, guildId });
  const label = provider.label ?? provider.key;

  const statusLabel =
    status === 'active' ? 'Connected' : status === 'degraded' ? 'Needs attention' : 'Not connected';

  return (
    <div className="store-row">
      <div className="store-row-icon" style={{ backgroundColor: provider.iconBg ?? '#1f2937' }}>
        {iconPath ? <img src={iconPath} alt={label} /> : null}
      </div>

      <div className="store-row-meta">
        <span className="store-row-name">{label}</span>
        <span className={`store-row-status ${status}`}>{statusLabel}</span>
      </div>

      <div className="store-row-action">
        {manageHref ? (
          <a href={manageHref} className="store-row-manage-btn">
            Configure
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </a>
        ) : null}
      </div>
    </div>
  );
}

export function StoreIntegrationsPanel({
  authUserId,
  guildId,
  canRunPanelQueries,
  onAuthError,
  onLinkedCountChange,
}: StoreIntegrationsPanelProps) {
  const providersQuery = useQuery(
    dashboardPanelQueryOptions<DashboardProvider[]>({
      queryKey: ['dashboard-providers'],
      queryFn: listDashboardProviders,
      enabled: canRunPanelQueries,
    })
  );
  const providers = providersQuery.data ?? [];

  const connectionStatusQuery = useQuery(
    dashboardPanelQueryOptions<Record<string, boolean>>({
      queryKey: ['dashboard-connection-status', authUserId],
      queryFn: () => getConnectionStatus(requireAuthUserId(authUserId)),
      enabled: canRunPanelQueries && Boolean(authUserId),
    })
  );
  const statusByProvider = connectionStatusQuery.data ?? {};

  const accountsQuery = useQuery(
    dashboardPanelQueryOptions<UserAccountConnection[]>({
      queryKey: ['dashboard-user-connections', authUserId],
      queryFn: () => listDashboardConnections(authUserId),
      enabled: canRunPanelQueries && Boolean(authUserId),
    })
  );
  const accounts = accountsQuery.data ?? [];

  const accountsByProvider = useMemo(() => {
    const map = new Map<string, UserAccountConnection>();
    for (const account of accounts) {
      if (!map.has(account.provider)) {
        map.set(account.provider, account);
      }
    }
    return map;
  }, [accounts]);

  const linkedProviders = useMemo(() => {
    return providers.filter(
      (provider) => provider.key !== 'discord' && statusByProvider[provider.key]
    );
  }, [providers, statusByProvider]);

  useEffect(() => {
    onLinkedCountChange?.(linkedProviders.length);
  }, [linkedProviders.length, onLinkedCountChange]);

  useEffect(() => {
    if (
      isDashboardAuthError(providersQuery.error) ||
      isDashboardAuthError(connectionStatusQuery.error) ||
      isDashboardAuthError(accountsQuery.error)
    ) {
      onAuthError?.();
    }
  }, [providersQuery.error, connectionStatusQuery.error, accountsQuery.error, onAuthError]);

  const isLoading =
    canRunPanelQueries &&
    (providersQuery.isLoading || connectionStatusQuery.isLoading || accountsQuery.isLoading);

  return (
    <section
      id="server-store-integrations-section"
      aria-label="Store Integrations"
      className="intg-card"
    >
      <div className="intg-header">
        <div className="intg-title-row">
          <div className="intg-icon">
            <img src="/Icons/Bag.png" alt="" />
          </div>
          <div className="intg-copy">
            <h2 className="intg-title">Storefronts</h2>
            <p className="intg-desc">Stores driving automated role-gating for this server.</p>
          </div>
        </div>
        {!isLoading && linkedProviders.length > 0 && (
          <span className="count-badge">{linkedProviders.length} linked</span>
        )}
      </div>

      <DashboardSkeletonSwap isLoading={isLoading} skeleton={<DashboardListSkeleton rows={3} />}>
        {linkedProviders.length === 0 ? (
          <div className="intg-empty-state">
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <path d="M16 10a4 4 0 0 1-8 0" />
            </svg>
            <p className="intg-empty-state-text">
              No stores connected yet. Link a storefront in <strong>Connected Platforms</strong> on
              your personal dashboard.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {linkedProviders.map((provider) => (
              <StoreRow
                key={provider.key}
                provider={provider}
                account={accountsByProvider.get(provider.key)}
                authUserId={authUserId}
                guildId={guildId}
              />
            ))}
          </div>
        )}
      </DashboardSkeletonSwap>
    </section>
  );
}
