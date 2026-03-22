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
  disconnectUserAccount,
  getProviderIconPath,
  listDashboardProviders,
  listUserAccounts,
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

  const providersQuery = useQuery(
    dashboardPanelQueryOptions<DashboardProvider[]>({
      queryKey: ['dashboard-providers'],
      queryFn: listDashboardProviders,
      enabled: canRunPanelQueries,
    })
  );

  const accountsQuery = useQuery(
    dashboardPanelQueryOptions<UserAccountConnection[]>({
      queryKey: ['dashboard-user-accounts'],
      queryFn: listUserAccounts,
      enabled: canRunPanelQueries,
    })
  );

  const disconnectMutation = useMutation({
    mutationFn: disconnectUserAccount,
    onSuccess: async () => {
      setPendingDisconnect(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard-user-accounts'] }),
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
      className="intg-card animate-in animate-in-delay-1"
      aria-label="Connected platforms"
    >
      {/* Header */}
      <div className="intg-header">
        <div className="intg-title-row">
          <div className="intg-icon">
            <img src="/Icons/Link.png" alt="" />
          </div>
          <div className="intg-copy">
            <h2 className="intg-title">Connected Platforms</h2>
            <p className="intg-desc">Storefronts linked for automated verification.</p>
          </div>
        </div>
        {!isLoading && totalCount > 1 && (
          <span className="inline-flex items-center rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-semibold text-zinc-600 dark:bg-white/10 dark:text-zinc-400">
            {connectedCount}&thinsp;/&thinsp;{totalCount}
          </span>
        )}
      </div>

      {/* Body */}
      <DashboardSkeletonSwap isLoading={isLoading} skeleton={<DashboardListSkeleton rows={4} />}>
        <div className="flex flex-col gap-2">
          {/* Discord - always active */}
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

          {/* Dynamic providers */}
          {platformProviders.map((provider) => {
            const account = accountsByProvider.get(provider.key);
            const isConnected = Boolean(account);
            const isThisDisconnecting =
              disconnectMutation.isPending && disconnectMutation.variables === account?.id;

            return (
              <div key={provider.key}>
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

                {/* Disconnect confirmation portal */}
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
              </div>
            );
          })}
        </div>
      </DashboardSkeletonSwap>
    </section>
  );
}
