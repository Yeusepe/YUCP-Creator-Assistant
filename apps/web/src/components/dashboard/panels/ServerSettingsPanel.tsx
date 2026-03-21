import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DashboardSkeletonSwap } from '@/components/dashboard/DashboardSkeletonSwap';
import { DashboardSettingsSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { DashboardPanelErrorState } from '@/components/dashboard/PanelErrorState';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { isDashboardAuthError } from '@/hooks/useDashboardSession';
import type { DashboardGuildChannel, DashboardPolicy, DashboardSettingKey } from '@/lib/dashboard';
import { getDashboardSettings, listGuildChannels, updateDashboardSetting } from '@/lib/dashboard';
import {
  dashboardClientRevalidateQueryOptions,
  dashboardPanelQueryOptions,
} from '@/lib/dashboardQueryOptions';

// ─── Props ───────────────────────────────────────────────────────────────────

export interface ServerSettingsPanelProps {
  authUserId: string;
  guildId: string;
  canRunPanelQueries: boolean;
  onAuthError?: () => void;
}

// ─── Types ───────────────────────────────────────────────────────────────────

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

// ─── Setting Configs ─────────────────────────────────────────────────────────

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

const CHANNEL_SETTINGS = [
  {
    key: 'logChannelId' as const,
    label: 'Logs Channel',
    hint: 'Channel where verification activity logs are posted.',
    icon: '/Icons/Library.png',
  },
  {
    key: 'announcementsChannelId' as const,
    label: 'Announcements Channel',
    hint: 'Channel where bot updates and announcements are posted.',
    icon: '/Icons/World.png',
  },
];

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Sub-components ──────────────────────────────────────────────────────────

function SaveIndicator({ settingKey, state }: { settingKey: string; state: SaveIndicatorState }) {
  return (
    <>
      <span
        className={[
          'inline-flex items-center transition-opacity duration-200',
          state === 'saved' ? 'opacity-100' : 'opacity-0',
        ].join(' ')}
        data-for={settingKey}
        aria-live="polite"
      >
        <svg
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-emerald-500 dark:text-emerald-400"
        >
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
          <polyline points="17 21 17 13 7 13 7 21" />
          <polyline points="7 3 7 8 15 8" />
        </svg>
      </span>
      <span
        className={[
          'inline-flex items-center transition-opacity duration-200',
          state === 'error' ? 'opacity-100' : 'opacity-0',
        ].join(' ')}
        data-for={settingKey}
        aria-live="assertive"
        hidden={state !== 'error'}
      >
        <svg
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-red-500 dark:text-red-400"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
      </span>
    </>
  );
}

function ToggleSwitch({
  id,
  checked,
  disabled,
  label,
  onChange,
}: {
  id: string;
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <div
      id={id}
      role="switch"
      tabIndex={0}
      aria-checked={checked}
      aria-label={label}
      aria-disabled={disabled}
      onClick={() => {
        if (!disabled) onChange();
      }}
      onKeyDown={(event) => {
        if (!disabled && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onChange();
        }
      }}
      className={[
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full',
        'transition-colors duration-200 ease-in-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2',
        'dark:focus-visible:ring-offset-zinc-900',
        checked ? 'bg-sky-500 dark:bg-sky-600' : 'bg-zinc-300 dark:bg-zinc-600',
        disabled ? 'opacity-50 cursor-not-allowed' : '',
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className={[
          'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm',
          'transition-transform duration-200 ease-in-out',
          checked ? 'translate-x-6' : 'translate-x-1',
        ].join(' ')}
      />
    </div>
  );
}

function SettingRow({
  icon,
  label,
  hint,
  control,
  indicator,
}: {
  icon: string;
  label: string;
  hint: string;
  control: React.ReactNode;
  indicator: React.ReactNode;
}) {
  return (
    <article className="flex items-center gap-4 rounded-xl px-4 py-3 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
        <img src={icon} alt="" className="h-4 w-4" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className="text-sm font-semibold text-zinc-900 dark:text-white"
          style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
        >
          {label}
        </span>
        <span
          className="text-xs text-zinc-500 dark:text-zinc-400"
          style={{ fontFamily: "'DM Sans', sans-serif" }}
        >
          {hint}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {control}
        {indicator}
      </div>
    </article>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function ServerSettingsPanel({
  authUserId,
  guildId,
  canRunPanelQueries,
  onAuthError,
}: ServerSettingsPanelProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [policyDraft, setPolicyDraft] = useState<NormalizedPolicy>(DEFAULT_POLICY);
  const [saveStates, setSaveStates] = useState<Record<string, SaveIndicatorState>>({});
  const timeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // ── Data fetching ────────────────────────────────────────────────────────

  const settingsQuery = useQuery(
    dashboardClientRevalidateQueryOptions<DashboardPolicy>({
      queryKey: ['dashboard-settings', authUserId],
      queryFn: () => getDashboardSettings(authUserId),
      enabled: canRunPanelQueries && Boolean(authUserId && guildId),
    })
  );

  const channelsQuery = useQuery(
    dashboardPanelQueryOptions<DashboardGuildChannel[]>({
      queryKey: ['dashboard-guild-channels', guildId, authUserId],
      queryFn: () => listGuildChannels(guildId, authUserId),
      enabled: canRunPanelQueries && Boolean(guildId && authUserId),
    })
  );

  // ── Sync draft from server ───────────────────────────────────────────────

  useEffect(() => {
    if (!settingsQuery.data) return;
    setPolicyDraft(toNormalizedPolicy(settingsQuery.data));
  }, [settingsQuery.data]);

  // ── Auth error detection ─────────────────────────────────────────────────

  useEffect(() => {
    if (isDashboardAuthError(settingsQuery.error) || isDashboardAuthError(channelsQuery.error)) {
      onAuthError?.();
    }
  }, [settingsQuery.error, channelsQuery.error, onAuthError]);

  // ── Cleanup timeouts ────────────────────────────────────────────────────

  useEffect(
    () => () => {
      for (const timeout of Object.values(timeoutsRef.current)) {
        clearTimeout(timeout);
      }
    },
    []
  );

  // ── Save state helpers ──────────────────────────────────────────────────

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

  // ── Mutation ────────────────────────────────────────────────────────────

  const saveSettingMutation = useMutation({
    mutationFn: async ({
      key,
      value,
    }: {
      key: DashboardSettingKey;
      value: DashboardPolicy[DashboardSettingKey];
    }) => updateDashboardSetting(authUserId, key, value),
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

  // ── Change handlers ─────────────────────────────────────────────────────

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

  // ── Loading / render ────────────────────────────────────────────────────

  const nonAuthError = [settingsQuery.error, channelsQuery.error].find(
    (err) => err && !isDashboardAuthError(err)
  );
  if (nonAuthError) {
    return (
      <DashboardPanelErrorState
        id="server-settings-error"
        title="Could not load server configuration"
        description={
          nonAuthError instanceof Error
            ? nonAuthError.message
            : 'An unexpected error occurred while loading settings.'
        }
        onRetry={() => Promise.all([settingsQuery.refetch(), channelsQuery.refetch()])}
      />
    );
  }

  const isLoading = canRunPanelQueries && (settingsQuery.isLoading || channelsQuery.isLoading);

  const channelOptions = [
    { value: '', label: '\u2014 None \u2014' },
    ...(channelsQuery.data?.map((ch) => ({
      value: ch.id,
      label: `#${ch.name}`,
    })) ?? []),
  ];

  return (
    <section
      id="server-settings-panel"
      aria-label="General Settings"
      className="intg-card relative"
    >
      {/* Sync bar */}
      {saveSettingMutation.isPending && (
        <div
          className="absolute inset-x-0 top-0 h-0.5 animate-pulse rounded-full bg-sky-500"
          aria-hidden="true"
        />
      )}

      <div className="intg-header">
        <div className="intg-title-row">
          <div className="intg-icon">
            <img src="/Icons/Wrench.png" alt="" />
          </div>
          <h2 className="intg-title">General Settings</h2>
        </div>
      </div>
      <p className="intg-desc">Configure verification policies and channel routing.</p>

      <DashboardSkeletonSwap
        isLoading={isLoading}
        skeleton={
          <DashboardSettingsSkeleton
            rows={
              SWITCH_SETTING_CONFIG.length + SELECT_SETTING_CONFIG.length + CHANNEL_SETTINGS.length
            }
          />
        }
      >
        <div className="flex flex-col gap-1">
          {/* Boolean toggle settings */}
          {SWITCH_SETTING_CONFIG.map((setting) => (
            <SettingRow
              key={setting.key}
              icon={setting.icon}
              label={setting.label}
              hint={setting.hint}
              control={
                <ToggleSwitch
                  id={`toggle-${setting.key}`}
                  checked={policyDraft[setting.key]}
                  disabled={saveSettingMutation.isPending}
                  label={setting.label}
                  onChange={() => onBooleanSettingChange(setting.key)}
                />
              }
              indicator={
                <SaveIndicator settingKey={setting.key} state={saveStates[setting.key] ?? 'idle'} />
              }
            />
          ))}

          {/* Select settings */}
          {SELECT_SETTING_CONFIG.map((setting) => (
            <SettingRow
              key={setting.key}
              icon={setting.icon}
              label={setting.label}
              hint={setting.hint}
              control={
                <Select
                  id={`select-${setting.key}`}
                  value={policyDraft[setting.key] as string}
                  options={setting.options}
                  disabled={saveSettingMutation.isPending}
                  onChange={(val) => onSelectSettingChange(setting.key, val)}
                />
              }
              indicator={
                <SaveIndicator settingKey={setting.key} state={saveStates[setting.key] ?? 'idle'} />
              }
            />
          ))}

          {/* Channel settings */}
          {CHANNEL_SETTINGS.map((setting) => (
            <SettingRow
              key={setting.key}
              icon={setting.icon}
              label={setting.label}
              hint={setting.hint}
              control={
                <Select
                  id={`select-${setting.key}`}
                  value={policyDraft[setting.key]}
                  options={channelOptions}
                  disabled={saveSettingMutation.isPending}
                  onChange={(val) => onSelectSettingChange(setting.key, val)}
                />
              }
              indicator={
                <SaveIndicator settingKey={setting.key} state={saveStates[setting.key] ?? 'idle'} />
              }
            />
          ))}
        </div>
      </DashboardSkeletonSwap>
    </section>
  );
}
