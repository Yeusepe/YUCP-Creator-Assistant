import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMutation as useConvexMutation, useQuery as useConvexQuery } from 'convex/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '@/api/client';
import { DashboardAuthRequiredState } from '@/components/dashboard/AuthRequiredState';
import { DashboardBodyPortal } from '@/components/dashboard/DashboardBodyPortal';
import { DashboardSkeletonSwap } from '@/components/dashboard/DashboardSkeletonSwap';
import {
  DashboardActionRowSkeleton,
  DashboardGridSkeleton,
  DashboardIntegrationsSkeleton,
  DashboardListSkeleton,
  DashboardSettingsSkeleton,
} from '@/components/dashboard/DashboardSkeletons';
import { DashboardPanelErrorState } from '@/components/dashboard/PanelErrorState';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { useActiveDashboardContext } from '@/hooks/useActiveDashboardContext';
import { isDashboardAuthError, useDashboardSession } from '@/hooks/useDashboardSession';
import { useDashboardShell } from '@/hooks/useDashboardShell';
import type {
  DashboardGuildChannel,
  DashboardPolicy,
  DashboardSettingKey,
  UserAccountConnection,
} from '@/lib/dashboard';
import {
  buildProviderConnectUrl,
  disconnectUserAccount,
  getConnectionStatus,
  getDashboardSettings,
  getProviderIconPath,
  listDashboardProviders,
  listGuildChannels,
  listUserAccounts,
  uninstallGuild,
  updateDashboardSetting,
} from '@/lib/dashboard';
import {
  dashboardClientRevalidateQueryOptions,
  dashboardPanelQueryOptions,
} from '@/lib/dashboardQueryOptions';
import { type DashboardProvider } from '@/lib/server/dashboard';
import { getServerIconUrl } from '@/lib/utils';
import { api } from '../../../../../convex/_generated/api';
import type { Id } from '../../../../../convex/_generated/dataModel';

export const Route = createFileRoute('/dashboard/')({
  component: DashboardIndex,
});

type SaveIndicatorState = 'idle' | 'saved' | 'error';

interface NormalizedPolicy {
  allowMismatchedEmails: boolean;
  autoVerifyOnJoin: boolean;
  shareVerificationWithServers: boolean;
  enableDiscordRoleFromOtherServers: boolean;
  verificationScope: 'account' | 'license';
  duplicateVerificationBehavior: 'allow' | 'notify' | 'block';
  suspiciousAccountBehavior: 'notify' | 'quarantine' | 'revoke';
  logChannelId: string;
  announcementsChannelId: string;
}

const DEFAULT_POLICY: NormalizedPolicy = {
  allowMismatchedEmails: false,
  autoVerifyOnJoin: false,
  shareVerificationWithServers: false,
  enableDiscordRoleFromOtherServers: false,
  verificationScope: 'account',
  duplicateVerificationBehavior: 'allow',
  suspiciousAccountBehavior: 'notify',
  logChannelId: '',
  announcementsChannelId: '',
};

const SWITCH_SETTING_CONFIG = [
  {
    key: 'allowMismatchedEmails',
    label: 'Allow Mismatched Emails',
    hint: 'Verify with a different email than Discord.',
    icon: '/Icons/World.png',
  },
  {
    key: 'autoVerifyOnJoin',
    label: 'Auto-Verify on Join',
    hint: 'Automatically verify members when they join the server.',
    icon: '/Icons/Refresh.png',
  },
  {
    key: 'shareVerificationWithServers',
    label: 'Share Across Servers',
    hint: 'Same Discord account, different servers. Verification carries over.',
    icon: '/Icons/Link.png',
  },
  {
    key: 'enableDiscordRoleFromOtherServers',
    label: 'Cross-Server Role Checks',
    hint: 'Check roles from servers the user is in.',
    icon: '/Icons/PersonKey.png',
  },
] as const satisfies ReadonlyArray<{
  key: Extract<
    DashboardSettingKey,
    | 'allowMismatchedEmails'
    | 'autoVerifyOnJoin'
    | 'shareVerificationWithServers'
    | 'enableDiscordRoleFromOtherServers'
  >;
  label: string;
  hint: string;
  icon: string;
}>;

const SELECT_SETTING_CONFIG = [
  {
    key: 'verificationScope',
    label: 'Verification Scope',
    hint: 'How verifications are scoped for buyers.',
    icon: '/Icons/Key.png',
    options: [
      { value: 'account', label: 'Account' },
      { value: 'license', label: 'License' },
    ],
  },
  {
    key: 'duplicateVerificationBehavior',
    label: 'Duplicate Verifications',
    hint: 'What happens when a user verifies twice.',
    icon: '/Icons/ClapStars.png',
    options: [
      { value: 'allow', label: 'Allow' },
      { value: 'notify', label: 'Notify' },
      { value: 'block', label: 'Block' },
    ],
  },
  {
    key: 'suspiciousAccountBehavior',
    label: 'Suspicious Accounts',
    hint: 'How to handle potentially fraudulent accounts.',
    icon: '/Icons/X.png',
    options: [
      { value: 'notify', label: 'Notify' },
      { value: 'quarantine', label: 'Quarantine' },
      { value: 'revoke', label: 'Revoke' },
    ],
  },
] as const satisfies ReadonlyArray<{
  key: Extract<
    DashboardSettingKey,
    'verificationScope' | 'duplicateVerificationBehavior' | 'suspiciousAccountBehavior'
  >;
  label: string;
  hint: string;
  icon: string;
  options: ReadonlyArray<{ value: string; label: string }>;
}>;

function toNormalizedPolicy(policy: DashboardPolicy | undefined): NormalizedPolicy {
  return {
    allowMismatchedEmails: policy?.allowMismatchedEmails ?? DEFAULT_POLICY.allowMismatchedEmails,
    autoVerifyOnJoin: policy?.autoVerifyOnJoin ?? DEFAULT_POLICY.autoVerifyOnJoin,
    shareVerificationWithServers:
      policy?.shareVerificationWithServers ?? DEFAULT_POLICY.shareVerificationWithServers,
    enableDiscordRoleFromOtherServers:
      policy?.enableDiscordRoleFromOtherServers ?? DEFAULT_POLICY.enableDiscordRoleFromOtherServers,
    verificationScope: policy?.verificationScope ?? DEFAULT_POLICY.verificationScope,
    duplicateVerificationBehavior:
      policy?.duplicateVerificationBehavior ?? DEFAULT_POLICY.duplicateVerificationBehavior,
    suspiciousAccountBehavior:
      policy?.suspiciousAccountBehavior ?? DEFAULT_POLICY.suspiciousAccountBehavior,
    logChannelId: policy?.logChannelId ?? DEFAULT_POLICY.logChannelId,
    announcementsChannelId: policy?.announcementsChannelId ?? DEFAULT_POLICY.announcementsChannelId,
  };
}

function DashboardIndex() {
  return (
    <div
      id="tab-panel-setup"
      className="dashboard-tab-panel is-active"
      role="tabpanel"
      aria-labelledby="tab-btn-setup"
    >
      <div className="bento-grid">
        <PersonalSetupPanel />
        <ConnectedPlatformsPanel />
        <ServerConfigPanel />
      </div>
    </div>
  );
}

function PersonalSetupPanel() {
  const navigate = useNavigate();
  const { guilds, viewer } = useDashboardShell();
  const isLoading = false;

  const openInstallFlow = useCallback(() => {
    if (!viewer?.authUserId || typeof window === 'undefined') {
      return;
    }

    window.location.assign(`/api/install/bot?authUserId=${encodeURIComponent(viewer.authUserId)}`);
  }, [viewer?.authUserId]);

  return (
    <section
      id="collab-servers-section"
      className="section-card bento-col-12 p-4 sm:p-5 md:p-7 animate-in animate-in-delay-1 personal-only"
      style={{ marginBottom: '24px' }}
    >
      <div className="flex items-center gap-3" style={{ gap: '12px', marginBottom: '24px' }}>
        <div
          className="w-8 h-8 rounded-xl flex items-center justify-center"
          style={{ background: 'rgba(14, 165, 233, 0.15)' }}
        >
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--accent-sky)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        </div>
        <h2 className="text-lg font-black" style={{ margin: 0 }}>
          Participating Servers
        </h2>
      </div>
      <p
        className="text-sm text-white/70"
        style={{ fontFamily: "'DM Sans', sans-serif", margin: '0 0 16px' }}
      >
        These are the servers you collaborate on. Use the dropdown in the sidebar to configure
        specific server settings.
      </p>

      <DashboardSkeletonSwap
        isLoading={isLoading}
        skeleton={<DashboardGridSkeleton cards={2} />}
        contentId="participating-servers-list"
        contentClassName="skeleton-content grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4"
      >
        {guilds.length === 0 ? (
          <div
            className="bento-col-12 empty-state platform-card flex items-center justify-center text-center"
            style={{ margin: 0 }}
          >
            <div>
              <div
                className="intg-icon"
                style={{
                  margin: '0 auto 16px',
                  width: '40px',
                  height: '40px',
                  background: 'rgba(14,165,233,0.1)',
                  color: '#0ea5e9',
                }}
              >
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
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </div>
              <p
                className="participating-server-name font-bold mb-2"
                style={{ fontFamily: "'Plus Jakarta Sans',sans-serif", fontSize: '16px' }}
              >
                No participating servers
              </p>
              <p
                className="participating-server-hint max-w-sm mx-auto mb-6"
                style={{
                  fontFamily: "'DM Sans',sans-serif",
                  fontSize: '13px',
                  lineHeight: 1.5,
                }}
              >
                You aren&apos;t managing any servers yet. Install the Assistant to your server to
                connect your storefront data.
              </p>
              <button className="btn-primary" type="button" onClick={openInstallFlow}>
                Add Assistant to Server
              </button>
            </div>
          </div>
        ) : (
          guilds.map((guild) => (
            <button
              key={guild.id}
              type="button"
              className="platform-card connected flex items-center gap-3 cursor-pointer hover:bg-white/5 transition-colors"
              style={{ padding: '12px 16px', textAlign: 'left' }}
              onClick={() =>
                navigate({
                  to: '/dashboard',
                  search: {
                    guild_id: guild.id,
                    ...(guild.tenantId ? { tenant_id: guild.tenantId } : {}),
                  },
                })
              }
            >
              {guild.icon ? (
                <img
                  src={getServerIconUrl(guild.id, guild.icon) ?? ''}
                  className="w-10 h-10 rounded-full object-cover"
                  alt=""
                  loading="lazy"
                />
              ) : (
                <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center font-bold text-white/70">
                  {guild.name
                    .split(' ')
                    .map((part) => part.charAt(0))
                    .join('')
                    .slice(0, 2)
                    .toUpperCase() || '?'}
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="participating-server-name font-bold text-base truncate">
                  {guild.name || 'Unnamed'}
                </div>
                <div className="participating-server-hint text-xs">Manage Settings →</div>
              </div>
            </button>
          ))
        )}
      </DashboardSkeletonSwap>
    </section>
  );
}

function ConnectedPlatformsPanel() {
  const { activeGuildId, activeTenantId } = useActiveDashboardContext();
  const { canRunPanelQueries, markSessionExpired, status } = useDashboardSession();
  const authUserId = activeTenantId;
  const guildId = activeGuildId;
  const [pendingProviderDisconnect, setPendingProviderDisconnect] = useState<string | null>(null);

  const providersQuery = useQuery(
    dashboardPanelQueryOptions<DashboardProvider[]>({
      queryKey: ['dashboard-providers'],
      queryFn: listDashboardProviders,
      enabled: canRunPanelQueries,
    })
  );
  const providers = providersQuery.data ?? [];
  const providersLoading = providersQuery.isLoading;
  const queryClient = useQueryClient();
  const accountsQuery = useQuery(
    dashboardPanelQueryOptions<UserAccountConnection[]>({
      queryKey: ['dashboard-user-accounts'],
      queryFn: listUserAccounts,
      enabled: canRunPanelQueries,
    })
  );
  const accounts = accountsQuery.data ?? [];
  const accountsLoading = accountsQuery.isLoading;

  const disconnectMutation = useMutation({
    mutationFn: disconnectUserAccount,
    onSuccess: async () => {
      setPendingProviderDisconnect(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard-user-accounts'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard-connection-status'] }),
      ]);
    },
  });

  useEffect(() => {
    if (isDashboardAuthError(providersQuery.error) || isDashboardAuthError(accountsQuery.error)) {
      markSessionExpired();
    }
  }, [accountsQuery.error, markSessionExpired, providersQuery.error]);

  const accountsByProvider = useMemo(() => {
    const next = new Map<string, UserAccountConnection>();
    for (const account of accounts) {
      if (!next.has(account.provider)) {
        next.set(account.provider, account);
      }
    }
    return next;
  }, [accounts]);

  const platformProviders = useMemo(
    () => providers.filter((provider) => provider.key !== 'discord' && provider.connectPath),
    [providers]
  );
  const unlinkedPlatformProviders = useMemo(
    () => platformProviders.filter((provider) => !accountsByProvider.has(provider.key)),
    [accountsByProvider, platformProviders]
  );

  const providerHref = useCallback(
    (provider: DashboardProvider) =>
      buildProviderConnectUrl(provider, {
        authUserId,
        guildId,
      }),
    [authUserId, guildId]
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

  const isLoading =
    status === 'resolving' || (canRunPanelQueries && (providersLoading || accountsLoading));

  return (
    <section
      id="connected-platforms-section"
      className="section-card bento-col-12 p-4 sm:p-5 md:p-7 animate-in animate-in-delay-2 personal-only"
    >
      <div className="flex items-center gap-3" style={{ gap: '12px', marginBottom: '24px' }}>
        <div
          className="w-8 h-8 rounded-xl flex items-center justify-center"
          style={{ background: 'rgba(255,235,59,0.15)' }}
        >
          <img src="/Icons/Link.png" className="w-4 h-4 object-contain" alt="" />
        </div>
        <h2 className="text-lg font-black">Connected Platforms</h2>
      </div>

      <DashboardSkeletonSwap
        isLoading={isLoading}
        skeleton={
          <>
            <DashboardActionRowSkeleton count={3} widths={[164, 184, 168]} />
            <DashboardListSkeleton rows={3} />
          </>
        }
        contentClassName="skeleton-content"
      >
        <div aria-hidden="true" style={{ marginBottom: '16px' }} />
        <div
          id="add-account-buttons"
          style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '24px' }}
        >
          {unlinkedPlatformProviders.map((provider) => {
            const href = providerHref(provider);
            return (
              <button
                key={provider.key}
                type="button"
                className="card-action-btn link"
                style={{
                  flex: 1,
                  minWidth: '160px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                }}
                onClick={() => {
                  if (!href || typeof window === 'undefined') {
                    return;
                  }
                  window.location.assign(href);
                }}
              >
                {provider.icon ? (
                  <img
                    src={getProviderIconPath(provider) ?? ''}
                    style={{ width: '16px', borderRadius: '3px' }}
                    alt=""
                  />
                ) : null}
                Add {provider.label ?? provider.key} Account
              </button>
            );
          })}
        </div>

        <div
          className="grid grid-cols-1 md:grid-cols-3 gap-4"
          id="platforms-grid"
          style={{ display: 'grid' }}
        >
          <div className="platform-card connected">
            <div className="flex items-start justify-between">
              <div className="w-10 h-10 bg-[#5865F2] rounded-xl flex items-center justify-center overflow-hidden">
                <img src="/Icons/Discord.png" className="w-6 h-6 object-contain" alt="Discord®" />
              </div>
              <span className="status-pill connected">Connected</span>
            </div>
            <div>
              <h3 className="font-bold text-base mb-0.5">Discord&reg;</h3>
              <p className="text-xs text-white/60" style={{ fontFamily: "'DM Sans',sans-serif" }}>
                Bot access active
              </p>
            </div>
          </div>

          <div id="dynamic-platform-cards" className="contents">
            {platformProviders.map((provider) => {
              const account = accountsByProvider.get(provider.key);
              return (
                <ProviderStatusCard
                  key={provider.key}
                  account={account}
                  isDisconnectOpen={pendingProviderDisconnect === provider.key}
                  isDisconnectPending={
                    disconnectMutation.isPending && disconnectMutation.variables === account?.id
                  }
                  onCloseDisconnect={() => setPendingProviderDisconnect(null)}
                  onConfirmDisconnect={() => {
                    if (account) {
                      disconnectMutation.mutate(account.id);
                    }
                  }}
                  onOpenDisconnect={() => setPendingProviderDisconnect(provider.key)}
                  onConnect={() => {
                    const href = providerHref(provider);
                    if (href && typeof window !== 'undefined') {
                      window.location.assign(href);
                    }
                  }}
                  provider={provider}
                />
              );
            })}
          </div>
        </div>
      </DashboardSkeletonSwap>
    </section>
  );
}

function ProviderStatusCard({
  provider,
  account,
  isDisconnectOpen,
  isDisconnectPending,
  onOpenDisconnect,
  onCloseDisconnect,
  onConfirmDisconnect,
  onConnect,
}: {
  provider: DashboardProvider;
  account: UserAccountConnection | undefined;
  isDisconnectOpen: boolean;
  isDisconnectPending: boolean;
  onOpenDisconnect: () => void;
  onCloseDisconnect: () => void;
  onConfirmDisconnect: () => void;
  onConnect: () => void;
}) {
  const isConnected = Boolean(account);
  const label = provider.label ?? provider.key;
  const iconPath = getProviderIconPath(provider);

  return (
    <div
      id={`${provider.key}-card`}
      className={`platform-card ${isConnected ? 'connected' : 'disconnected'}`}
    >
      <div className="flex items-start justify-between">
        <div
          className="w-10 h-10 rounded-xl overflow-hidden flex items-center justify-center"
          style={{ background: provider.iconBg ?? '#1f2937' }}
        >
          {iconPath ? <img className="w-6 h-6 object-contain" src={iconPath} alt={label} /> : null}
        </div>
        <span
          id={`${provider.key}-status`}
          className={`status-pill ${isConnected ? 'connected' : 'disconnected'}`}
        >
          {isConnected ? 'Connected' : 'Not Linked'}
        </span>
      </div>
      <div>
        <h3 className="font-bold text-base mb-0.5">{label}</h3>
        <p className="text-xs text-white/60" style={{ fontFamily: "'DM Sans',sans-serif" }}>
          {account?.label ?? 'Connect this provider to enable creator syncing.'}
        </p>
      </div>
      <button
        id={`${provider.key}-btn`}
        className={`card-action-btn ${isConnected ? 'disconnect' : 'link'}`}
        type="button"
        onClick={isConnected ? onOpenDisconnect : onConnect}
      >
        {isConnected ? 'Disconnect' : 'Link Account'}
      </button>
      <DashboardBodyPortal>
        <div
          className={`inline-confirm${isDisconnectOpen ? ' open' : ''}`}
          id={`${provider.key}-disconnect-confirm`}
        >
          <div>
            <div className="inline-confirm-body">
              <span className="inline-confirm-label">
                Disconnect <strong>{label}</strong>? This removes all syncing.
              </span>
              <div className="inline-confirm-btns">
                <button className="inline-cancel-btn" type="button" onClick={onCloseDisconnect}>
                  Cancel
                </button>
                <button
                  className="inline-danger-btn"
                  id={`${provider.key}-confirm-btn`}
                  type="button"
                  disabled={isDisconnectPending}
                  onClick={onConfirmDisconnect}
                >
                  {isDisconnectPending ? 'Disconnecting…' : 'Disconnect'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </DashboardBodyPortal>
    </div>
  );
}

const SETTING_LABELS: Record<string, string> = {
  allowMismatchedEmails: 'Allow mismatched emails',
  autoVerifyOnJoin: 'Auto-verify on join',
  shareVerificationWithServers: 'Share verification across servers',
  enableDiscordRoleFromOtherServers: 'Enable roles from other servers',
  verificationScope: 'Verification scope',
  duplicateVerificationBehavior: 'Duplicate verification behavior',
  suspiciousAccountBehavior: 'Suspicious account behavior',
  logChannelId: 'Log channel',
  announcementsChannelId: 'Announcements channel',
};

function getDashboardPanelErrorDetails(error: unknown) {
  if (!error || isDashboardAuthError(error)) {
    return null;
  }

  if (error instanceof ApiError) {
    const description =
      typeof error.body === 'object' &&
      error.body !== null &&
      'error' in error.body &&
      typeof error.body.error === 'string'
        ? error.body.error
        : error.message;

    return {
      description,
      requestId: error.requestId,
    };
  }

  if (error instanceof Error) {
    return {
      description: error.message,
      requestId: undefined,
    };
  }

  return {
    description: 'An unexpected error occurred while loading dashboard data.',
    requestId: undefined,
  };
}

function ServerConfigPanel() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { activeGuildId, activeTenantId } = useActiveDashboardContext();
  const { canRunPanelQueries, markSessionExpired, status } = useDashboardSession();
  const authUserId = activeTenantId;
  const guildId = activeGuildId;
  const [policyDraft, setPolicyDraft] = useState<NormalizedPolicy>(DEFAULT_POLICY);
  const [saveStates, setSaveStates] = useState<Record<string, SaveIndicatorState>>({});
  const [disconnectStep, setDisconnectStep] = useState(0);
  const timeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Live Convex subscription for bot-to-dashboard notifications
  const adminNotifications = useConvexQuery(api.adminNotifications.listUnseen) ?? [];
  const markSeenMutation = useConvexMutation(api.adminNotifications.markSeen);
  const seenNotificationIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    const unseen = adminNotifications.filter(
      (n: { _id: Id<'admin_notifications'>; type: string; title: string; message?: string }) =>
        !seenNotificationIds.current.has(n._id)
    );
    if (unseen.length === 0) return;

    const ids = unseen.map((n: { _id: Id<'admin_notifications'> }) => n._id);
    for (const id of ids) {
      seenNotificationIds.current.add(id);
    }

    for (const n of unseen as Array<{
      _id: Id<'admin_notifications'>;
      type: 'success' | 'error' | 'warning' | 'info';
      title: string;
      message?: string;
    }>) {
      const opts = n.message ? { description: n.message } : undefined;
      if (n.type === 'success') toast.success(n.title, opts);
      else if (n.type === 'error') toast.error(n.title, opts);
      else if (n.type === 'warning') toast.warning(n.title, opts);
      else toast.info(n.title, opts);
    }

    markSeenMutation({ ids }).catch(() => {
      // best-effort — notifications will expire via cron anyway
    });
  }, [adminNotifications, toast, markSeenMutation]);

  const providersQuery = useQuery(
    dashboardPanelQueryOptions<DashboardProvider[]>({
      queryKey: ['dashboard-providers'],
      queryFn: listDashboardProviders,
      enabled: canRunPanelQueries,
    })
  );
  const providers = providersQuery.data ?? [];
  const providersLoading = providersQuery.isLoading;
  const connectionStatusQuery = useQuery(
    dashboardPanelQueryOptions<Record<string, boolean>>({
      queryKey: ['dashboard-connection-status', authUserId],
      queryFn: () => getConnectionStatus(requireAuthUserId(authUserId)),
      enabled: canRunPanelQueries && Boolean(authUserId),
    })
  );
  const statusByProvider = connectionStatusQuery.data ?? {};
  const connectionStatusLoading = connectionStatusQuery.isLoading;
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
  const settingsQuery = useQuery(
    dashboardClientRevalidateQueryOptions<DashboardPolicy>({
      queryKey: ['dashboard-settings', authUserId],
      queryFn: () => getDashboardSettings(requireAuthUserId(authUserId)),
      enabled: canRunPanelQueries && Boolean(authUserId && guildId),
    })
  );
  const channelsQuery = useQuery(
    dashboardPanelQueryOptions<DashboardGuildChannel[]>({
      queryKey: ['dashboard-guild-channels', guildId, authUserId],
      queryFn: () => listGuildChannels(requireGuildId(guildId), authUserId),
      enabled: canRunPanelQueries && Boolean(guildId && authUserId),
    })
  );

  useEffect(() => {
    if (
      isDashboardAuthError(providersQuery.error) ||
      isDashboardAuthError(connectionStatusQuery.error) ||
      isDashboardAuthError(accountsQuery.error) ||
      isDashboardAuthError(settingsQuery.error) ||
      isDashboardAuthError(channelsQuery.error)
    ) {
      markSessionExpired();
    }
  }, [
    accountsQuery.error,
    channelsQuery.error,
    connectionStatusQuery.error,
    markSessionExpired,
    providersQuery.error,
    settingsQuery.error,
  ]);

  useEffect(() => {
    if (!settingsQuery.data) {
      return;
    }
    setPolicyDraft(toNormalizedPolicy(settingsQuery.data));
  }, [settingsQuery.data]);

  useEffect(
    () => () => {
      for (const timeout of Object.values(timeoutsRef.current)) {
        clearTimeout(timeout);
      }
    },
    []
  );

  const linkedProviders = useMemo(() => {
    return providers.filter(
      (provider) => provider.key !== 'discord' && statusByProvider[provider.key]
    );
  }, [providers, statusByProvider]);

  const setSaveState = useCallback((key: string, state: SaveIndicatorState) => {
    setSaveStates((current) => ({ ...current, [key]: state }));
    const existingTimeout = timeoutsRef.current[key];
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    if (state === 'idle') {
      delete timeoutsRef.current[key];
      return;
    }

    timeoutsRef.current[key] = setTimeout(
      () => setSaveStates((current) => ({ ...current, [key]: 'idle' })),
      state === 'saved' ? 2200 : 3000
    );
  }, []);

  const saveSettingMutation = useMutation({
    mutationFn: async ({
      key,
      value,
    }: {
      key: DashboardSettingKey;
      value: DashboardPolicy[DashboardSettingKey];
    }) => updateDashboardSetting(requireAuthUserId(authUserId), key, value),
    onSuccess: async (_, variables) => {
      setSaveState(variables.key, 'saved');
      await queryClient.invalidateQueries({ queryKey: ['dashboard-settings', authUserId] });
    },
    onError: (_error, variables) => {
      if (settingsQuery.data) {
        setPolicyDraft(toNormalizedPolicy(settingsQuery.data));
      }
      setSaveState(variables.key, 'error');
      toast.error(`Could not save "${SETTING_LABELS[variables.key] ?? variables.key}"`, {
        description: 'Check your connection and try again.',
        duration: 5000,
      });
    },
  });

  const uninstallMutation = useMutation({
    mutationFn: () => uninstallGuild(requireGuildId(guildId)),
    onSuccess: async () => {
      setDisconnectStep(0);
      toast.success('Server disconnected successfully');
      await queryClient.invalidateQueries({ queryKey: ['dashboard-guilds'] });
      navigate({ to: '/dashboard', search: {} });
    },
    onError: () => {
      setDisconnectStep(0);
      toast.error('Could not disconnect server', {
        description: 'Please try again or contact support.',
        duration: 6000,
      });
    },
  });

  const onBooleanSettingChange = useCallback(
    (
      key: Extract<
        DashboardSettingKey,
        | 'allowMismatchedEmails'
        | 'autoVerifyOnJoin'
        | 'shareVerificationWithServers'
        | 'enableDiscordRoleFromOtherServers'
      >
    ) => {
      const nextValue = !policyDraft[key];
      setPolicyDraft((current) => ({ ...current, [key]: nextValue }));
      saveSettingMutation.mutate({ key, value: nextValue });
    },
    [policyDraft, saveSettingMutation]
  );

  const onSelectSettingChange = useCallback(
    (
      key: Extract<
        DashboardSettingKey,
        | 'verificationScope'
        | 'duplicateVerificationBehavior'
        | 'suspiciousAccountBehavior'
        | 'logChannelId'
        | 'announcementsChannelId'
      >,
      value: string
    ) => {
      setPolicyDraft((current) => ({ ...current, [key]: value }) as NormalizedPolicy);
      saveSettingMutation.mutate({
        key,
        value: value as DashboardPolicy[DashboardSettingKey],
      });
    },
    [saveSettingMutation]
  );

  const serverConfigError =
    getDashboardPanelErrorDetails(providersQuery.error) ??
    getDashboardPanelErrorDetails(connectionStatusQuery.error) ??
    getDashboardPanelErrorDetails(accountsQuery.error) ??
    getDashboardPanelErrorDetails(settingsQuery.error) ??
    getDashboardPanelErrorDetails(channelsQuery.error);

  if (
    isDashboardAuthError(providersQuery.error) ||
    isDashboardAuthError(connectionStatusQuery.error) ||
    isDashboardAuthError(accountsQuery.error) ||
    isDashboardAuthError(settingsQuery.error) ||
    isDashboardAuthError(channelsQuery.error) ||
    status === 'signed_out' ||
    status === 'expired'
  ) {
    return (
      <DashboardAuthRequiredState
        id="dashboard-server-config-auth-required"
        title="Sign in to manage server configuration"
        description="Your dashboard session expired while loading server configuration. Sign in again to keep managing settings and channels."
      />
    );
  }

  if (serverConfigError) {
    return (
      <div
        id="server-settings-card"
        className="svr-cfg bento-col-12 animate-in animate-in-delay-3 server-only"
      >
        <div className="svr-cfg-bar">
          <h2 className="svr-cfg-title">Server Config</h2>
        </div>
        <div className="settings-subsection">
          <div className="settings-subsection-title">General</div>
          <DashboardPanelErrorState
            id="dashboard-server-config-error"
            title="Could not load server configuration"
            description={serverConfigError.description}
            requestId={serverConfigError.requestId}
            onRetry={() =>
              Promise.all([
                providersQuery.refetch(),
                connectionStatusQuery.refetch(),
                accountsQuery.refetch(),
                settingsQuery.refetch(),
                channelsQuery.refetch(),
              ])
            }
          />
        </div>
      </div>
    );
  }

  const isLoading =
    status === 'resolving' ||
    (canRunPanelQueries &&
      (providersLoading ||
        connectionStatusLoading ||
        settingsQuery.isLoading ||
        channelsQuery.isLoading));

  return (
    <div
      id="server-settings-card"
      className="svr-cfg bento-col-12 animate-in animate-in-delay-3 server-only"
    >
      {saveSettingMutation.isPending && <div className="dashboard-sync-bar" aria-hidden="true" />}
      <div className="svr-cfg-bar">
        <h2 className="svr-cfg-title">Server Config</h2>
      </div>

      <div className="settings-subsection" id="server-store-integrations-section">
        <div className="settings-subsection-title">Store Integrations</div>
        <div>
          <DashboardSkeletonSwap
            isLoading={isLoading}
            skeleton={<DashboardIntegrationsSkeleton cards={3} />}
            contentClassName="intg-provider-grid skeleton-content"
          >
            {linkedProviders.map((provider) => {
              const account = accountsByProvider.get(provider.key);
              const statusValue = account?.status ?? 'active';
              const badgeClass =
                statusValue === 'degraded'
                  ? 'degraded'
                  : statusValue === 'disconnected'
                    ? 'disconnected'
                    : 'active';
              const badgeLabel =
                statusValue === 'degraded'
                  ? 'Degraded'
                  : statusValue === 'disconnected'
                    ? 'Disconnected'
                    : 'Active';
              const iconPath = getProviderIconPath(provider);
              const manageHref = buildProviderConnectUrl(provider, { authUserId, guildId });
              return (
                <article
                  key={provider.key}
                  className="intg-provider-card"
                  id={`server-tile-${provider.key}`}
                  style={
                    provider.iconBg
                      ? ({
                          '--provider-accent': `${provider.iconBg}33`,
                          '--provider-icon-bg': provider.iconBg,
                        } as React.CSSProperties)
                      : undefined
                  }
                >
                  <div className="intg-provider-card-header">
                    <div className="intg-provider-logo-wrap">
                      <div className="intg-provider-logo-halo" />
                      <div className="intg-provider-logo">
                        {iconPath ? (
                          <img src={iconPath} alt={provider.label ?? provider.key} />
                        ) : null}
                      </div>
                    </div>
                    <div className="intg-provider-meta">
                      <h3 className="intg-provider-name">{provider.label ?? provider.key}</h3>
                      <span className={`intg-status-badge ${badgeClass}`}>{badgeLabel}</span>
                    </div>
                  </div>
                  <p className="intg-provider-hint">
                    {provider.serverTileHint ??
                      'Allow users to verify purchases in this Discord server.'}
                  </p>
                  <div className="intg-provider-card-footer">
                    <div className="flex items-center gap-2">
                      <div
                        id={`toggle-serverEnable${provider.key[0]?.toUpperCase() ?? ''}${provider.key.slice(1)}`}
                        className="svr-cfg-switch active"
                        aria-hidden="true"
                      />
                      <span className="intg-provider-enable-label">Enabled</span>
                    </div>
                    {manageHref ? (
                      <a href={manageHref} className="intg-manage-btn">
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
            })}
            {linkedProviders.length === 0 ? (
              <div id="server-integrations-empty" className="intg-provider-card-empty">
                <div className="intg-provider-card-empty-icon">
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
                <p>
                  No stores connected yet. Add a store account in{' '}
                  <strong>Connected Platforms</strong> above.
                </p>
              </div>
            ) : null}
          </DashboardSkeletonSwap>
        </div>
      </div>

      <div className="settings-subsection">
        <div className="settings-subsection-title">General</div>
        <div className="settings-subsection-body">
          <DashboardSkeletonSwap
            isLoading={isLoading}
            skeleton={
              <DashboardSettingsSkeleton
                rows={SWITCH_SETTING_CONFIG.length + SELECT_SETTING_CONFIG.length + 2}
              />
            }
            contentClassName="skeleton-content"
          >
            {SWITCH_SETTING_CONFIG.map((setting) => (
              <article key={setting.key} className="svr-cfg-tile">
                <div className="svr-cfg-tile-head">
                  <div className="svr-cfg-tile-icon">
                    <img src={setting.icon} alt="" />
                  </div>
                  <div className="svr-cfg-tile-text">
                    <span className="svr-cfg-tile-label">{setting.label}</span>
                    <span className="svr-cfg-tile-hint">{setting.hint}</span>
                  </div>
                </div>
                <div className="svr-cfg-tile-ctrl">
                  <div
                    id={`toggle-${setting.key}`}
                    className={`svr-cfg-switch${policyDraft[setting.key] ? ' active' : ''}${
                      saveSettingMutation.isPending &&
                      saveSettingMutation.variables?.key === setting.key
                        ? ' saving'
                        : ''
                    }`}
                    role="switch"
                    tabIndex={0}
                    aria-checked={policyDraft[setting.key]}
                    aria-label={setting.label}
                    aria-disabled={saveSettingMutation.isPending}
                    onClick={() => {
                      if (!saveSettingMutation.isPending) onBooleanSettingChange(setting.key);
                    }}
                    onKeyDown={(event) => {
                      if (
                        !saveSettingMutation.isPending &&
                        (event.key === 'Enter' || event.key === ' ')
                      ) {
                        event.preventDefault();
                        onBooleanSettingChange(setting.key);
                      }
                    }}
                  />
                  <SaveIndicator
                    settingKey={setting.key}
                    state={saveStates[setting.key] ?? 'idle'}
                  />
                </div>
              </article>
            ))}

            {SELECT_SETTING_CONFIG.map((setting) => (
              <article key={setting.key} className="svr-cfg-tile">
                <div className="svr-cfg-tile-head">
                  <div className="svr-cfg-tile-icon">
                    <img src={setting.icon} alt="" />
                  </div>
                  <div className="svr-cfg-tile-text">
                    <span className="svr-cfg-tile-label">{setting.label}</span>
                    <span className="svr-cfg-tile-hint">{setting.hint}</span>
                  </div>
                </div>
                <div className="svr-cfg-tile-ctrl">
                  <Select
                    id={`select-${setting.key}`}
                    value={policyDraft[setting.key] as string}
                    options={setting.options}
                    disabled={saveSettingMutation.isPending}
                    onChange={(val) => onSelectSettingChange(setting.key, val)}
                  />
                  <SaveIndicator
                    settingKey={setting.key}
                    state={saveStates[setting.key] ?? 'idle'}
                  />
                </div>
              </article>
            ))}

            <article className="svr-cfg-tile">
              <div className="svr-cfg-tile-head">
                <div className="svr-cfg-tile-icon">
                  <img src="/Icons/Library.png" alt="" />
                </div>
                <div className="svr-cfg-tile-text">
                  <span className="svr-cfg-tile-label">Logs Channel</span>
                  <span className="svr-cfg-tile-hint">
                    Channel where verification activity logs are posted.
                  </span>
                </div>
              </div>
              <div className="svr-cfg-tile-ctrl">
                <Select
                  id="select-logChannelId"
                  value={policyDraft.logChannelId}
                  options={[
                    { value: '', label: '— None —' },
                    ...(channelsQuery.data?.map((ch) => ({
                      value: ch.id,
                      label: `#${ch.name}`,
                    })) ?? []),
                  ]}
                  onChange={(val) => onSelectSettingChange('logChannelId', val)}
                />
                <SaveIndicator
                  settingKey="logChannelId"
                  state={saveStates.logChannelId ?? 'idle'}
                />
              </div>
            </article>

            <article className="svr-cfg-tile">
              <div className="svr-cfg-tile-head">
                <div className="svr-cfg-tile-icon">
                  <img src="/Icons/World.png" alt="" />
                </div>
                <div className="svr-cfg-tile-text">
                  <span className="svr-cfg-tile-label">Announcements Channel</span>
                  <span className="svr-cfg-tile-hint">
                    Channel where bot updates and announcements are posted.
                  </span>
                </div>
              </div>
              <div className="svr-cfg-tile-ctrl">
                <Select
                  id="select-announcementsChannelId"
                  value={policyDraft.announcementsChannelId}
                  options={[
                    { value: '', label: '— None —' },
                    ...(channelsQuery.data?.map((ch) => ({
                      value: ch.id,
                      label: `#${ch.name}`,
                    })) ?? []),
                  ]}
                  onChange={(val) => onSelectSettingChange('announcementsChannelId', val)}
                />
                <SaveIndicator
                  settingKey="announcementsChannelId"
                  state={saveStates.announcementsChannelId ?? 'idle'}
                />
              </div>
            </article>
          </DashboardSkeletonSwap>
        </div>
      </div>

      <div className="settings-subsection danger-zone">
        <div className="settings-subsection-title" style={{ color: '#ef4444' }}>
          Danger Zone
        </div>
        <div className="settings-subsection-body">
          <article className="svr-cfg-tile" style={{ border: '1px solid rgba(239,68,68,0.15)' }}>
            <div className="svr-cfg-tile-head">
              <div
                className="svr-cfg-tile-icon"
                style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}
              >
                <svg
                  aria-hidden="true"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </div>
              <div className="svr-cfg-tile-text">
                <span className="svr-cfg-tile-label">Disconnect Server</span>
                <span className="svr-cfg-tile-hint">
                  Permanently remove this server and delete all verification data.
                </span>
              </div>
            </div>
            <div className="svr-cfg-tile-ctrl">
              <button
                id="server-disconnect-btn"
                type="button"
                className="card-action-btn disconnect"
                style={{
                  background: 'rgba(239,68,68,0.1)',
                  border: '1px solid rgba(239,68,68,0.3)',
                  color: '#ef4444',
                  padding: '8px 16px',
                  borderRadius: '10px',
                  fontSize: '13px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontFamily: "'Plus Jakarta Sans', sans-serif",
                  transition: 'all 0.2s',
                  whiteSpace: 'nowrap',
                }}
                onClick={() => setDisconnectStep((current) => (current === 0 ? 1 : 0))}
              >
                Disconnect
              </button>
            </div>
          </article>

          <div
            id="server-disconnect-steps"
            style={{ display: disconnectStep === 0 ? 'none' : 'block' }}
          >
            {disconnectStep > 0 ? (
              <ServerDisconnectSteps
                currentStep={disconnectStep}
                isPending={uninstallMutation.isPending}
                onAdvance={() => setDisconnectStep((current) => Math.min(3, current + 1))}
                onBack={() => setDisconnectStep(0)}
                onConfirm={() => uninstallMutation.mutate()}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function SaveIndicator({ settingKey, state }: { settingKey: string; state: SaveIndicatorState }) {
  return (
    <>
      <span
        className={`save-indicator tile-save-indicator${state === 'saved' ? ' visible' : ''}`}
        data-for={settingKey}
        aria-live="polite"
      >
        <svg
          aria-hidden="true"
          className="save-indicator-icon"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
          <polyline points="17 21 17 13 7 13 7 21" />
          <polyline points="7 3 7 8 15 8" />
        </svg>
      </span>
      <span
        className={`save-indicator save-indicator-error tile-save-error${
          state === 'error' ? ' visible' : ''
        }`}
        data-for={settingKey}
        aria-live="assertive"
        hidden={state !== 'error'}
      >
        <svg
          aria-hidden="true"
          className="save-indicator-icon"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
      </span>
    </>
  );
}

function ServerDisconnectSteps({
  currentStep,
  isPending,
  onAdvance,
  onBack,
  onConfirm,
}: {
  currentStep: number;
  isPending: boolean;
  onAdvance: () => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const steps = [
    null,
    {
      emoji: '⚠️',
      title: 'Warning: Disconnect Server',
      text: 'This will permanently remove your server from Creator Assistant. All role rules and verification data for this server will be deleted.',
      buttonLabel: 'I Understand',
      bgColor: 'rgba(255,165,0,0.12)',
      borderColor: 'rgba(255,165,0,0.24)',
      buttonBg: 'rgba(255,165,0,0.18)',
      buttonBorder: 'rgba(255,165,0,0.35)',
      color: '#ffb74d',
    },
    {
      emoji: '🗑️',
      title: 'Delete Server Data',
      text: 'This cannot be undone. Role rules, product mappings, and download routes linked to this guild will be removed.',
      buttonLabel: 'Continue',
      bgColor: 'rgba(239,68,68,0.12)',
      borderColor: 'rgba(239,68,68,0.24)',
      buttonBg: 'rgba(239,68,68,0.18)',
      buttonBorder: 'rgba(239,68,68,0.35)',
      color: '#f87171',
    },
    {
      emoji: '🔒',
      title: 'Final Confirmation',
      text: 'Only proceed if you are certain. The bot will be disconnected from this guild and you will return to your personal dashboard.',
      buttonLabel: 'Confirm Disconnect',
      bgColor: 'rgba(220,38,38,0.16)',
      borderColor: 'rgba(220,38,38,0.28)',
      buttonBg: 'rgba(220,38,38,0.22)',
      buttonBorder: 'rgba(220,38,38,0.4)',
      color: '#fca5a5',
    },
  ] as const;

  const step = steps[currentStep];
  if (!step) {
    return null;
  }

  return (
    <div
      style={{
        marginTop: '16px',
        background: step.bgColor,
        border: `1px solid ${step.borderColor}`,
        borderRadius: '14px',
        padding: '18px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: '14px',
        }}
      >
        <div style={{ fontSize: '24px', lineHeight: 1 }}>{step.emoji}</div>
        <div style={{ flex: 1 }}>
          <h3
            style={{
              margin: '0 0 8px',
              fontSize: '16px',
              fontWeight: 800,
              fontFamily: "'Plus Jakarta Sans', sans-serif",
              color: step.color,
            }}
          >
            {step.title}
          </h3>
          <p
            style={{
              fontSize: '13px',
              color: 'rgba(255,255,255,0.7)',
              margin: '0 0 14px',
              fontFamily: "'DM Sans', sans-serif",
              lineHeight: 1.5,
            }}
          >
            {step.text}
          </p>
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button
              id="dc-step-cancel"
              type="button"
              onClick={onBack}
              style={{
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: 'rgba(255,255,255,0.7)',
                padding: '8px 16px',
                borderRadius: '8px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: "'Plus Jakarta Sans', sans-serif",
                transition: 'all 0.2s',
              }}
            >
              Cancel
            </button>
            <button
              id="dc-step-next"
              type="button"
              disabled={isPending}
              onClick={currentStep < 3 ? onAdvance : onConfirm}
              style={{
                background: step.buttonBg,
                border: `1px solid ${step.buttonBorder}`,
                color: step.color,
                padding: '8px 16px',
                borderRadius: '8px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: "'Plus Jakarta Sans', sans-serif",
                transition: 'all 0.2s',
              }}
            >
              {isPending && currentStep === 3 ? 'Disconnecting…' : step.buttonLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function requireAuthUserId(authUserId: string | undefined) {
  if (!authUserId) {
    throw new Error('Not authenticated');
  }

  return authUserId;
}

function requireGuildId(guildId: string | undefined) {
  if (!guildId) {
    throw new Error('No guild selected');
  }

  return guildId;
}
