import { Switch } from '@heroui/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DashboardSkeletonSwap } from '@/components/dashboard/DashboardSkeletonSwap';
import { DashboardSettingsSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { DashboardPanelErrorState } from '@/components/dashboard/PanelErrorState';
import { Icon } from '@/components/ui/Icon';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { YucpButton } from '@/components/ui/YucpButton';
import { YucpInput } from '@/components/ui/YucpInput';
import { isDashboardAuthError } from '@/hooks/useDashboardSession';
import type { IconName } from '@/icons/manifest';
import type {
  CreatorIdentity,
  DashboardGuildChannel,
  DashboardPolicy,
  DashboardSettingKey,
} from '@/lib/dashboard';
import {
  getCreatorIdentity,
  getDashboardSettings,
  listGuildChannels,
  updateCreatorIdentity,
  updateDashboardSetting,
} from '@/lib/dashboard';
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
    icon: 'globe',
  },
  {
    key: 'autoVerifyOnJoin',
    label: 'Auto-Verify on Join',
    hint: 'Automatically verify members when they join the server.',
    icon: 'refresh',
  },
  {
    key: 'shareVerificationWithServers',
    label: 'Share Across Servers',
    hint: 'Same Discord account, different servers. Verification carries over.',
    icon: 'link',
  },
  {
    key: 'enableDiscordRoleFromOtherServers',
    label: 'Cross-Server Role Checks',
    hint: 'Check roles from servers the user is in.',
    icon: 'userKey',
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
  icon: IconName;
}>;

const SELECT_SETTING_CONFIG = [
  {
    key: 'verificationScope',
    label: 'Verification Scope',
    hint: 'How verifications are scoped for buyers.',
    icon: 'key',
    options: [
      { value: 'account', label: 'Account' },
      { value: 'license', label: 'License' },
    ],
  },
  {
    key: 'duplicateVerificationBehavior',
    label: 'Duplicate Verifications',
    hint: 'What happens when a user verifies twice.',
    icon: 'refresh',
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
    icon: 'alert',
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
  icon: IconName;
  options: ReadonlyArray<{ value: string; label: string }>;
}>;

const CHANNEL_SETTINGS = [
  {
    key: 'logChannelId' as const,
    label: 'Logs Channel',
    hint: 'Channel where verification activity logs are posted.',
    icon: 'auditLog',
  },
  {
    key: 'announcementsChannelId' as const,
    label: 'Announcements Channel',
    hint: 'Channel where bot updates and announcements are posted.',
    icon: 'bell',
  },
] as const satisfies ReadonlyArray<{
  key: Extract<DashboardSettingKey, 'logChannelId' | 'announcementsChannelId'>;
  label: string;
  hint: string;
  icon: IconName;
}>;

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
        style={{ opacity: state === 'saved' ? 1 : 0, transition: 'opacity 0.2s' }}
        data-for={settingKey}
        aria-live="polite"
      >
        <Icon name="success" size={14} className="text-green-500" />
      </span>
      <span
        style={{ opacity: state === 'error' ? 1 : 0, transition: 'opacity 0.2s' }}
        data-for={settingKey}
        aria-live="assertive"
        hidden={state !== 'error'}
      >
        <Icon name="close" size={14} className="text-red-500" />
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
    <div id={id}>
      <Switch
        isSelected={checked}
        isDisabled={disabled}
        onChange={() => onChange()}
        aria-label={label}
        size="sm"
      >
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch.Content>
      </Switch>
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
  icon: IconName;
  label: string;
  hint: string;
  control: React.ReactNode;
  indicator: React.ReactNode;
}) {
  return (
    <article className="setting-row">
      <div className="setting-row-icon">
        <Icon name={icon} />
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span className="setting-row-label">{label}</span>
        <span className="setting-row-hint">{hint}</span>
      </div>
      <div style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 8 }}>
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
  const [identityDraft, setIdentityDraft] = useState<CreatorIdentity>({
    deliverySlug: '',
    name: '',
    privateVpmHostname: null,
    publicSlug: '',
  });
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

  const identityQuery = useQuery(
    dashboardClientRevalidateQueryOptions<CreatorIdentity>({
      queryKey: ['creator-identity'],
      queryFn: getCreatorIdentity,
      enabled: canRunPanelQueries,
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

  useEffect(() => {
    if (!identityQuery.data) return;
    setIdentityDraft(identityQuery.data);
  }, [identityQuery.data]);

  // ── Auth error detection ─────────────────────────────────────────────────

  useEffect(() => {
    if (
      isDashboardAuthError(identityQuery.error) ||
      isDashboardAuthError(settingsQuery.error) ||
      isDashboardAuthError(channelsQuery.error)
    ) {
      onAuthError?.();
    }
  }, [identityQuery.error, settingsQuery.error, channelsQuery.error, onAuthError]);

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

  const saveIdentityMutation = useMutation({
    mutationFn: (input: { deliverySlug: string; name: string; publicSlug: string }) =>
      updateCreatorIdentity(input),
    onSuccess: async (identity) => {
      setIdentityDraft(identity);
      toast.success('Creator identity saved', {
        description: 'New links use your updated creator and product namespaces.',
      });
      await queryClient.invalidateQueries({ queryKey: ['creator-identity'] });
    },
    onError: (error) => {
      if (identityQuery.data) {
        setIdentityDraft(identityQuery.data);
      }
      toast.error('Could not save creator identity', {
        description: error instanceof Error ? error.message : 'Check the values and try again.',
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

  const nonAuthError = [identityQuery.error, settingsQuery.error, channelsQuery.error].find(
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
        onRetry={() =>
          Promise.all([identityQuery.refetch(), settingsQuery.refetch(), channelsQuery.refetch()])
        }
      />
    );
  }

  const isLoading =
    canRunPanelQueries &&
    (identityQuery.isLoading || settingsQuery.isLoading || channelsQuery.isLoading);

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
          style={{
            position: 'absolute',
            inset: '0 0 auto 0',
            height: 2,
            borderRadius: 999,
            background: '#0ea5e9',
            animation: 'pulse 1.4s ease-in-out infinite',
          }}
          aria-hidden="true"
        />
      )}

      <div className="intg-header">
        <div className="intg-title-row">
          <div className="intg-icon">
            <Icon name="settings" />
          </div>
          <div className="intg-copy">
            <h2 className="intg-title">General Settings</h2>
            <p className="intg-desc">Configure verification policies and channel routing.</p>
          </div>
        </div>
      </div>

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
        <div className="mb-5 rounded-2xl border border-foreground/10 bg-foreground/[0.025] p-4 dark:border-foreground/10 dark:bg-foreground/[0.035]">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-foreground text-sm font-semibold dark:text-foreground">
                Creator identity
              </h3>
              <p className="text-foreground/60 mt-1 text-sm dark:text-foreground/60">
                Controls your public creator links and private VPM hostname.
              </p>
            </div>
            <YucpButton
              yucp="primary"
              size="sm"
              isLoading={saveIdentityMutation.isPending}
              isDisabled={
                saveIdentityMutation.isPending ||
                !identityDraft.name.trim() ||
                !identityDraft.publicSlug.trim() ||
                !identityDraft.deliverySlug.trim()
              }
              aria-label="Save creator identity"
              onPress={() =>
                saveIdentityMutation.mutate({
                  deliverySlug: identityDraft.deliverySlug,
                  name: identityDraft.name,
                  publicSlug: identityDraft.publicSlug,
                })
              }
            >
              {saveIdentityMutation.isPending ? 'Saving...' : 'Save identity'}
            </YucpButton>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <label className="space-y-2" htmlFor="creator-display-name">
              <span className="text-foreground text-xs font-semibold dark:text-foreground">
                Display name
              </span>
              <YucpInput
                id="creator-display-name"
                aria-label="Creator display name"
                value={identityDraft.name}
                isDisabled={saveIdentityMutation.isPending}
                onValueChange={(name) => setIdentityDraft((current) => ({ ...current, name }))}
              />
            </label>
            <label className="space-y-2" htmlFor="creator-public-handle">
              <span className="text-foreground text-xs font-semibold dark:text-foreground">
                Public handle
              </span>
              <YucpInput
                id="creator-public-handle"
                aria-label="Public creator handle"
                value={identityDraft.publicSlug}
                isDisabled={saveIdentityMutation.isPending}
                onValueChange={(publicSlug) =>
                  setIdentityDraft((current) => ({ ...current, publicSlug }))
                }
              />
              <span className="text-foreground/55 block text-xs dark:text-foreground/55">
                /get-in-unity/{identityDraft.publicSlug || 'your-handle'}/...
              </span>
            </label>
            <label className="space-y-2" htmlFor="creator-private-vpm-subdomain">
              <span className="text-foreground text-xs font-semibold dark:text-foreground">
                Private VPM subdomain
              </span>
              <YucpInput
                id="creator-private-vpm-subdomain"
                aria-label="Private VPM subdomain"
                value={identityDraft.deliverySlug}
                isDisabled={saveIdentityMutation.isPending}
                onValueChange={(deliverySlug) =>
                  setIdentityDraft((current) => ({ ...current, deliverySlug }))
                }
              />
              <span className="text-foreground/55 block break-all text-xs dark:text-foreground/55">
                {identityDraft.privateVpmHostname ??
                  `${identityDraft.deliverySlug || 'your-handle'}.private.yucp.club`}
              </span>
            </label>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
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
