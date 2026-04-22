import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { DashboardAuthRequiredState } from '@/components/dashboard/AuthRequiredState';
import { PlatformCard } from '@/components/dashboard/cards/PlatformCard';
import { DashboardBodyPortal } from '@/components/dashboard/DashboardBodyPortal';
import { DashboardSkeletonSwap } from '@/components/dashboard/DashboardSkeletonSwap';
import { DashboardListSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { DashboardPanelErrorState } from '@/components/dashboard/PanelErrorState';
import { useActiveDashboardContext } from '@/hooks/useActiveDashboardContext';
import { isDashboardAuthError, useDashboardSession } from '@/hooks/useDashboardSession';
import type { UserAccountConnection } from '@/lib/dashboard';
import {
  buildProviderConnectUrl,
  disconnectDashboardConnection,
  getProviderIconPath,
  listDashboardConnections,
  listDashboardProviders,
} from '@/lib/dashboard';
import { dashboardPanelQueryOptions } from '@/lib/dashboardQueryOptions';
import type { DashboardProvider } from '@/lib/server/dashboard';

interface ConnectedPlatformsPanelProps {
  onCountsChange?: (connected: number, total: number) => void;
}

export function ConnectedPlatformsPanel({ onCountsChange }: ConnectedPlatformsPanelProps) {
  const { activeGuildId, activeTenantId } = useActiveDashboardContext();
  const { canRunPanelQueries, markSessionExpired, status } = useDashboardSession();
  const queryClient = useQueryClient();

  const [pendingDisconnect, setPendingDisconnect] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const providersQuery = useQuery(
    dashboardPanelQueryOptions<DashboardProvider[]>({
      queryKey: ['dashboard-providers'],
      queryFn: listDashboardProviders,
      enabled: canRunPanelQueries,
    })
  );

  const accountsQuery = useQuery(
    dashboardPanelQueryOptions<UserAccountConnection[]>({
      queryKey: ['dashboard-user-connections', activeTenantId],
      queryFn: () => listDashboardConnections(activeTenantId),
      enabled: canRunPanelQueries && Boolean(activeTenantId),
    })
  );

  const disconnectMutation = useMutation({
    mutationFn: (connectionId: string) =>
      disconnectDashboardConnection(connectionId, activeTenantId),
    onSuccess: async () => {
      setPendingDisconnect(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard-user-connections', activeTenantId] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard-connection-status'] }),
      ]);
    },
  });

  const providers = providersQuery.data ?? [];
  const accounts = accountsQuery.data ?? [];

  useEffect(() => {
    if (isDashboardAuthError(providersQuery.error) || isDashboardAuthError(accountsQuery.error)) {
      markSessionExpired();
    }
  }, [accountsQuery.error, markSessionExpired, providersQuery.error]);

  const accountsByProvider = useMemo(() => {
    const map = new Map<string, UserAccountConnection>();
    for (const account of accounts) {
      if (!map.has(account.provider)) {
        map.set(account.provider, account);
      }
    }
    return map;
  }, [accounts]);

  const platformProviders = useMemo(
    () => providers.filter((p) => p.key !== 'discord' && p.connectPath),
    [providers]
  );

  const connectedProviders = useMemo(
    () => platformProviders.filter((p) => accountsByProvider.has(p.key)),
    [platformProviders, accountsByProvider]
  );

  const unconnectedProviders = useMemo(
    () => platformProviders.filter((p) => !accountsByProvider.has(p.key)),
    [platformProviders, accountsByProvider]
  );

  const visibleProviders = showAll ? platformProviders : connectedProviders;

  const connectedCount = useMemo(
    () => 1 + platformProviders.filter((p) => accountsByProvider.has(p.key)).length,
    [platformProviders, accountsByProvider]
  );
  const totalCount = 1 + platformProviders.length;

  useEffect(() => {
    if (!providersQuery.isLoading && !accountsQuery.isLoading) {
      onCountsChange?.(connectedCount, totalCount);
    }
  }, [
    connectedCount,
    totalCount,
    onCountsChange,
    providersQuery.isLoading,
    accountsQuery.isLoading,
  ]);

  const getProviderHref = useCallback(
    (provider: DashboardProvider) =>
      buildProviderConnectUrl(provider, {
        authUserId: activeTenantId,
        guildId: activeGuildId,
      }),
    [activeTenantId, activeGuildId]
  );

  if (isDashboardAuthError(providersQuery.error) || isDashboardAuthError(accountsQuery.error)) {
    return (
      <DashboardAuthRequiredState
        id="dashboard-platforms-auth-required"
        title="Sign in to manage connected platforms"
        description="Your dashboard session expired while loading connected platforms. Sign in again to keep managing provider connections."
      />
    );
  }

  const nonAuthError = [providersQuery.error, accountsQuery.error].find(
    (err) => err && !isDashboardAuthError(err)
  );
  if (nonAuthError) {
    const description =
      nonAuthError instanceof Error
        ? nonAuthError.message
        : 'An unexpected error occurred while loading platforms.';
    return (
      <DashboardPanelErrorState
        id="dashboard-platforms-error"
        title="Could not load platforms"
        description={description}
        onRetry={() => Promise.all([providersQuery.refetch(), accountsQuery.refetch()])}
      />
    );
  }

  const isLoading =
    status === 'resolving' ||
    (canRunPanelQueries && (providersQuery.isLoading || accountsQuery.isLoading));

  return (
    <section
      id="connected-platforms-panel"
      className="section-card cpp-panel connected-platforms-panel animate-in animate-in-delay-1"
      aria-label="Connected platforms"
    >
      <header className="cpp-panel__header">
        <div className="cpp-panel__title-row">
          <h2 className="cpp-panel__title">Sales channels</h2>
          {!isLoading && totalCount > 1 ? (
            <span className="cpp-panel__count">
              {connectedCount} of {totalCount}
            </span>
          ) : null}
        </div>
        <p className="cpp-panel__lead">
          Link marketplaces so verification can use purchase data from your accounts.
        </p>
      </header>

      <DashboardSkeletonSwap isLoading={isLoading} skeleton={<DashboardListSkeleton rows={4} />}>
        <ul className="cpp-panel__list">
          <li className="cpp-panel__item">
            <PlatformCard
              providerKey="discord"
              label="Discord"
              iconPath="/Icons/Discord.png"
              iconBg="#5865F2"
              isConnected={true}
              accountLabel="Bot access active"
              isAlwaysActive={true}
              onConnect={() => {}}
              onDisconnect={() => {}}
            />
          </li>

          {visibleProviders.map((provider) => {
            const account = accountsByProvider.get(provider.key);
            const isConnected = Boolean(account);
            const isThisDisconnecting =
              disconnectMutation.isPending && disconnectMutation.variables === account?.id;

            return (
              <li key={provider.key} className="cpp-panel__item">
                <PlatformCard
                  providerKey={provider.key}
                  label={provider.label ?? provider.key}
                  iconPath={getProviderIconPath(provider)}
                  iconBg={provider.iconBg}
                  isConnected={isConnected}
                  accountLabel={account?.label}
                  isDisconnecting={isThisDisconnecting}
                  onConnect={() => {
                    const href = getProviderHref(provider);
                    if (href && typeof window !== 'undefined') {
                      window.location.assign(href);
                    }
                  }}
                  onDisconnect={() => setPendingDisconnect(provider.key)}
                />

                <DashboardBodyPortal>
                  <div
                    className={`inline-confirm${pendingDisconnect === provider.key ? ' open' : ''}`}
                    id={`${provider.key}-disconnect-confirm`}
                  >
                    <div>
                      <div className="inline-confirm-body">
                        <span className="inline-confirm-label">
                          Disconnect <strong>{provider.label ?? provider.key}</strong>? This removes
                          all syncing.
                        </span>
                        <div className="inline-confirm-btns">
                          <button
                            className="inline-cancel-btn"
                            type="button"
                            onClick={() => setPendingDisconnect(null)}
                          >
                            Cancel
                          </button>
                          <button
                            className="inline-danger-btn"
                            id={`${provider.key}-confirm-btn`}
                            type="button"
                            disabled={isThisDisconnecting}
                            onClick={() => {
                              if (account) {
                                disconnectMutation.mutate(account.id);
                              }
                            }}
                          >
                            {isThisDisconnecting ? 'Disconnecting...' : 'Disconnect'}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </DashboardBodyPortal>
              </li>
            );
          })}

          {!showAll && unconnectedProviders.length > 0 && (
            <li className="cpp-panel__item">
              <button className="btn-show-more" type="button" onClick={() => setShowAll(true)}>
                Show {unconnectedProviders.length} more
              </button>
            </li>
          )}

          {showAll && unconnectedProviders.length > 0 && (
            <li className="cpp-panel__item">
              <button className="btn-show-more" type="button" onClick={() => setShowAll(false)}>
                Show less
              </button>
            </li>
          )}
        </ul>
      </DashboardSkeletonSwap>
    </section>
  );
}
