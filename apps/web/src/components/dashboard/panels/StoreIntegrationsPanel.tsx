import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { DashboardSkeletonSwap } from '@/components/dashboard/DashboardSkeletonSwap';
import { DashboardIntegrationsSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { isDashboardAuthError } from '@/hooks/useDashboardSession';
import type { UserAccountConnection } from '@/lib/dashboard';
import {
  buildProviderConnectUrl,
  getConnectionStatus,
  getProviderIconPath,
  listDashboardProviders,
  listUserAccounts,
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

const STATUS_BADGE_CLASSES: Record<ProviderStatus, string> = {
  active: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400',
  degraded: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
  disconnected: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
};

const STATUS_DOT_CLASSES: Record<ProviderStatus, string> = {
  active: 'bg-emerald-500',
  degraded: 'bg-amber-500',
  disconnected: 'bg-red-500',
};

const STATUS_LABELS: Record<ProviderStatus, string> = {
  active: 'Active',
  degraded: 'Degraded',
  disconnected: 'Disconnected',
};

function EmptyStoreState() {
  return (
    <div className="flex min-h-[120px] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-zinc-300 px-6 py-8 dark:border-white/10">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500">
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
        >
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
        </svg>
      </div>
      <p className="max-w-xs text-center text-sm text-zinc-500 dark:text-zinc-400">
        No stores connected yet. Add a store account in{' '}
        <strong className="font-semibold text-zinc-700 dark:text-zinc-300">
          Connected Platforms
        </strong>{' '}
        above.
      </p>
    </div>
  );
}

function StoreCard({
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
  const statusValue: ProviderStatus = (account?.status as ProviderStatus) ?? 'active';
  const iconPath = getProviderIconPath(provider);
  const manageHref = buildProviderConnectUrl(provider, { authUserId, guildId });
  const label = provider.label ?? provider.key;

  return (
    <article
      id={`server-tile-${provider.key}`}
      className={[
        'flex min-w-[220px] flex-col gap-4 rounded-2xl p-5',
        'bg-zinc-50 border border-zinc-200/60',
        'transition-all duration-200',
        'hover:border-zinc-300 hover:shadow-sm',
        'dark:bg-[rgba(15,23,42,0.5)] dark:border-white/10',
        'dark:hover:border-white/15 dark:hover:bg-[rgba(30,41,59,0.6)]',
      ].join(' ')}
    >
      {/* Header: icon + meta */}
      <div className="flex items-center gap-3">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: provider.iconBg ?? '#1f2937' }}
        >
          {iconPath ? <img src={iconPath} alt={label} className="h-5 w-5 object-contain" /> : null}
        </div>
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-bold text-zinc-900 dark:text-white">{label}</h3>
          <span
            className={[
              'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
              STATUS_BADGE_CLASSES[statusValue],
            ].join(' ')}
          >
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${STATUS_DOT_CLASSES[statusValue]}`}
              aria-hidden="true"
            />
            {STATUS_LABELS[statusValue]}
          </span>
        </div>
      </div>

      {/* Footer: manage link */}
      <div className="mt-auto flex items-center justify-end">
        {manageHref ? (
          <a
            href={manageHref}
            className={[
              'inline-flex items-center gap-1.5 rounded-[10px] px-3 py-1.5',
              'text-xs font-semibold text-sky-600',
              'bg-sky-50 transition-colors hover:bg-sky-100',
              'dark:bg-sky-900/30 dark:text-sky-400 dark:hover:bg-sky-900/50',
            ].join(' ')}
          >
            Manage
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
    </article>
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
      queryKey: ['dashboard-user-accounts'],
      queryFn: listUserAccounts,
      enabled: canRunPanelQueries,
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

  // Notify parent of linked provider count changes
  useEffect(() => {
    onLinkedCountChange?.(linkedProviders.length);
  }, [linkedProviders.length, onLinkedCountChange]);

  // Notify parent on auth errors
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
          <h2 className="intg-title">Store Integrations</h2>
        </div>
      </div>
      <p className="intg-desc">Storefronts linked to this server for automated role-gating.</p>

      <DashboardSkeletonSwap
        isLoading={isLoading}
        skeleton={<DashboardIntegrationsSkeleton cards={3} />}
      >
        {linkedProviders.length === 0 ? (
          <EmptyStoreState />
        ) : (
          <div className="flex gap-4 overflow-x-auto pb-2">
            {linkedProviders.map((provider) => (
              <StoreCard
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
