import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useServerContext } from '@/hooks/useServerContext';
import type {
  DashboardGuildChannel,
  DashboardPolicy,
  DashboardProvider,
  DashboardSettingKey,
  UserAccountConnection,
} from '@/lib/dashboard';
import {
  buildProviderConnectUrl,
  disconnectUserAccount,
  getDashboardSettings,
  getProviderIconPath,
  listDashboardProviders,
  listGuildChannels,
  listUserAccounts,
  uninstallGuild,
  updateDashboardSetting,
} from '@/lib/dashboard';
import {
  type DashboardViewer,
  fetchDashboardViewer,
  fetchGuilds,
  type Guild,
} from '@/lib/server/dashboard';
import { getServerIconUrl } from '@/lib/utils';

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
  const { data: viewer } = useQuery<DashboardViewer>({
    queryKey: ['dashboard-viewer'],
    queryFn: () => fetchDashboardViewer(),
  });
  const { data: guilds = [], isLoading } = useQuery<Guild[]>({
    queryKey: ['dashboard-guilds'],
    queryFn: () => fetchGuilds(),
  });

  const openInstallFlow = useCallback(() => {
    if (!viewer?.authUserId || typeof window === 'undefined') {
      return;
    }

    window.location.assign(`/api/install/bot?authUserId=${encodeURIComponent(viewer.authUserId)}`);
  }, [viewer?.authUserId]);

  return (
    <section
      id="collab-servers-section"
      className={`section-card bento-col-12 p-4 sm:p-5 md:p-7 animate-in animate-in-delay-1 personal-only${
        !isLoading ? ' skeleton-loaded' : ''
      }`}
      style={{ marginBottom: '24px' }}
    >
      <div className="flex items-center gap-3 mb-6">
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
      <p className="text-sm text-white/70 mb-4" style={{ fontFamily: "'DM Sans', sans-serif" }}>
        These are the servers you collaborate on. Use the dropdown in the sidebar to configure
        specific server settings.
      </p>

      <div
        className="skeleton-group"
        aria-hidden="true"
        style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}
      >
        <div className="skeleton-block skeleton-card" />
        <div className="skeleton-block skeleton-card" />
      </div>

      {!isLoading ? (
        <div
          id="participating-servers-list"
          className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4"
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
        </div>
      ) : null}
    </section>
  );
}

function ConnectedPlatformsPanel() {
  const { guildId, tenantId } = useServerContext();
  const { data: viewer } = useQuery<DashboardViewer>({
    queryKey: ['dashboard-viewer'],
    queryFn: () => fetchDashboardViewer(),
  });
  const authUserId = tenantId ?? viewer?.authUserId;
  const queryClient = useQueryClient();
  const [pendingProviderDisconnect, setPendingProviderDisconnect] = useState<string | null>(null);

  const { data: providers = [], isLoading: providersLoading } = useQuery<DashboardProvider[]>({
    queryKey: ['dashboard-providers'],
    queryFn: listDashboardProviders,
  });
  const { data: accounts = [], isLoading: accountsLoading } = useQuery<UserAccountConnection[]>({
    queryKey: ['dashboard-user-accounts', viewer?.authUserId],
    queryFn: listUserAccounts,
    enabled: Boolean(viewer?.authUserId),
  });

  const disconnectMutation = useMutation({
    mutationFn: disconnectUserAccount,
    onSuccess: async () => {
      setPendingProviderDisconnect(null);
      await queryClient.invalidateQueries({ queryKey: ['dashboard-user-accounts'] });
    },
  });

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

  const providerHref = useCallback(
    (provider: DashboardProvider) =>
      buildProviderConnectUrl(provider, {
        authUserId,
        guildId,
      }),
    [authUserId, guildId]
  );

  const isLoading = providersLoading || accountsLoading;

  return (
    <section
      id="connected-platforms-section"
      className={`section-card bento-col-12 p-4 sm:p-5 md:p-7 animate-in animate-in-delay-2 personal-only${
        !isLoading ? ' skeleton-loaded' : ''
      }`}
    >
      <div className="flex items-center gap-3 mb-6">
        <div
          className="w-8 h-8 rounded-xl flex items-center justify-center"
          style={{ background: 'rgba(255,235,59,0.15)' }}
        >
          <img src="/Icons/Link.png" className="w-4 h-4 object-contain" alt="" />
        </div>
        <h2 className="text-lg font-black">Connected Platforms</h2>
      </div>

      <div className="skeleton-group" aria-hidden="true">
        <div className="skeleton-block skeleton-card" />
        <div className="skeleton-block skeleton-card" />
        <div className="skeleton-block skeleton-card" />
      </div>

      {!isLoading ? (
        <>
          <div
            id="user-accounts-list"
            className="grid grid-cols-1 md:grid-cols-3 gap-4"
            style={{ marginBottom: '16px' }}
          >
            {accounts.length === 0 ? (
              <div
                style={{
                  color: 'rgba(255,255,255,0.5)',
                  fontSize: '14px',
                  fontFamily: "'DM Sans',sans-serif",
                  padding: '16px 0',
                }}
              >
                No store accounts linked yet. Use the buttons below to connect.
              </div>
            ) : (
              accounts.map((account) => (
                <ConnectedAccountCard
                  key={account.id}
                  account={account}
                  provider={providers.find((provider) => provider.key === account.provider)}
                  isPending={
                    disconnectMutation.isPending && disconnectMutation.variables === account.id
                  }
                  onDisconnect={() => disconnectMutation.mutate(account.id)}
                />
              ))
            )}
          </div>

          <div
            id="add-account-buttons"
            style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '24px' }}
          >
            {platformProviders.map((provider) => {
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
        </>
      ) : null}
    </section>
  );
}

function ConnectedAccountCard({
  account,
  provider,
  isPending,
  onDisconnect,
}: {
  account: UserAccountConnection;
  provider: DashboardProvider | undefined;
  isPending: boolean;
  onDisconnect: () => void;
}) {
  const label = provider?.label ?? account.provider;
  const iconPath = getProviderIconPath(provider ?? {});
  const iconBg = provider?.iconBg ?? '#333333';

  return (
    <div className="platform-card connected" style={{ position: 'relative' }}>
      <div className="flex items-start justify-between">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center overflow-hidden"
          style={{ background: iconBg, flexShrink: 0 }}
        >
          {iconPath ? <img src={iconPath} className="w-6 h-6 object-contain" alt={label} /> : null}
        </div>
        <span className="status-pill connected">Connected</span>
      </div>
      <div>
        <h3 className="font-bold text-base mb-0.5">{label}</h3>
        <p className="text-xs text-white/60" style={{ fontFamily: "'DM Sans',sans-serif" }}>
          {account.label}
        </p>
      </div>
      <button
        className="card-action-btn disconnect"
        type="button"
        disabled={isPending}
        onClick={() => {
          if (
            !window.confirm(
              `Disconnect this ${label} account? This removes syncing for all servers.`
            )
          ) {
            return;
          }
          onDisconnect();
        }}
      >
        {isPending ? 'Disconnecting…' : 'Disconnect'}
      </button>
    </div>
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
    </div>
  );
}

function ServerConfigPanel() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { guildId, tenantId } = useServerContext();
  const { data: viewer } = useQuery<DashboardViewer>({
    queryKey: ['dashboard-viewer'],
    queryFn: () => fetchDashboardViewer(),
  });
  const authUserId = tenantId ?? viewer?.authUserId;
  const [policyDraft, setPolicyDraft] = useState<NormalizedPolicy>(DEFAULT_POLICY);
  const [saveStates, setSaveStates] = useState<Record<string, SaveIndicatorState>>({});
  const [disconnectStep, setDisconnectStep] = useState(0);
  const timeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const { data: providers = [] } = useQuery<DashboardProvider[]>({
    queryKey: ['dashboard-providers'],
    queryFn: listDashboardProviders,
  });
  const { data: accounts = [] } = useQuery<UserAccountConnection[]>({
    queryKey: ['dashboard-user-accounts', viewer?.authUserId],
    queryFn: listUserAccounts,
    enabled: Boolean(viewer?.authUserId),
  });
  const settingsQuery = useQuery<DashboardPolicy>({
    queryKey: ['dashboard-settings', authUserId],
    queryFn: () => getDashboardSettings(requireAuthUserId(authUserId)),
    enabled: Boolean(authUserId && guildId),
  });
  const channelsQuery = useQuery<DashboardGuildChannel[]>({
    queryKey: ['dashboard-guild-channels', guildId, authUserId],
    queryFn: () => listGuildChannels(requireGuildId(guildId), authUserId),
    enabled: Boolean(guildId && authUserId),
  });

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
    const keys = new Set(accounts.map((account) => account.provider));
    return providers.filter((provider) => keys.has(provider.key) && provider.key !== 'discord');
  }, [accounts, providers]);

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
    },
  });

  const uninstallMutation = useMutation({
    mutationFn: () => uninstallGuild(requireGuildId(guildId)),
    onSuccess: async () => {
      setDisconnectStep(0);
      await queryClient.invalidateQueries({ queryKey: ['dashboard-guilds'] });
      navigate({ to: '/dashboard', search: {} });
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

  const isLoading = settingsQuery.isLoading || channelsQuery.isLoading;

  return (
    <div
      id="server-settings-card"
      className={`svr-cfg bento-col-12 animate-in animate-in-delay-3 server-only${
        !isLoading ? ' skeleton-loaded' : ''
      }`}
    >
      <div className="svr-cfg-bar">
        <h2 className="svr-cfg-title">Server Config</h2>
      </div>

      <div className="settings-subsection" id="server-store-integrations-section">
        <div className="settings-subsection-title">Store Integrations</div>
        <div className="settings-subsection-body">
          <div id="dynamic-server-provider-tiles">
            {linkedProviders.map((provider) => (
              <article
                key={provider.key}
                className="svr-cfg-tile"
                id={`server-tile-${provider.key}`}
              >
                <div className="svr-cfg-tile-head">
                  <div className="svr-cfg-tile-icon">
                    {provider.icon ? (
                      <img
                        src={getProviderIconPath(provider) ?? ''}
                        alt={provider.label ?? provider.key}
                        style={{ borderRadius: '4px' }}
                      />
                    ) : null}
                  </div>
                  <div className="svr-cfg-tile-text">
                    <span className="svr-cfg-tile-label">
                      Enable {provider.label ?? provider.key} for this Server
                    </span>
                    <span className="svr-cfg-tile-hint">
                      {provider.serverTileHint ??
                        'Allow users to verify purchases in this Discord server.'}
                    </span>
                  </div>
                </div>
                <div className="svr-cfg-tile-ctrl">
                  <div
                    id={`toggle-serverEnable${provider.key[0]?.toUpperCase() ?? ''}${provider.key.slice(1)}`}
                    className="svr-cfg-switch active"
                    aria-hidden="true"
                  />
                </div>
              </article>
            ))}
          </div>
          <div className="skeleton-group" aria-hidden="true">
            <div className="skeleton-block skeleton-card" />
            <div className="skeleton-block skeleton-card" />
          </div>
          {!isLoading && linkedProviders.length === 0 ? (
            <div
              id="server-integrations-empty"
              className="p-4 bg-white/5 border border-white/10 rounded-xl text-center text-sm text-[rgba(255,255,255,0.6)]"
            >
              No store accounts linked. Add a store account in the{' '}
              <strong>Connected Platforms</strong> section above.
            </div>
          ) : null}
        </div>
      </div>

      <div className="settings-subsection">
        <div className="settings-subsection-title">General</div>
        <div className="settings-subsection-body">
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
                  onClick={() => onBooleanSettingChange(setting.key)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onBooleanSettingChange(setting.key);
                    }
                  }}
                />
                <SaveIndicator settingKey={setting.key} state={saveStates[setting.key] ?? 'idle'} />
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
                <select
                  id={`select-${setting.key}`}
                  className="svr-cfg-pick"
                  value={policyDraft[setting.key]}
                  onChange={(event) => onSelectSettingChange(setting.key, event.target.value)}
                >
                  {setting.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <SaveIndicator settingKey={setting.key} state={saveStates[setting.key] ?? 'idle'} />
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
              <select
                id="select-logChannelId"
                className="svr-cfg-pick"
                value={policyDraft.logChannelId}
                onChange={(event) => onSelectSettingChange('logChannelId', event.target.value)}
              >
                <option value="">— None —</option>
                {channelsQuery.data?.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    #{channel.name}
                  </option>
                ))}
              </select>
              <SaveIndicator settingKey="logChannelId" state={saveStates.logChannelId ?? 'idle'} />
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
              <select
                id="select-announcementsChannelId"
                className="svr-cfg-pick"
                value={policyDraft.announcementsChannelId}
                onChange={(event) =>
                  onSelectSettingChange('announcementsChannelId', event.target.value)
                }
              >
                <option value="">— None —</option>
                {channelsQuery.data?.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    #{channel.name}
                  </option>
                ))}
              </select>
              <SaveIndicator
                settingKey="announcementsChannelId"
                state={saveStates.announcementsChannelId ?? 'idle'}
              />
            </div>
          </article>
        </div>
      </div>

      <div className="settings-subsection" style={{ marginTop: '16px' }}>
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
