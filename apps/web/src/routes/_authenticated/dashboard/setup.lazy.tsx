import { createLazyFileRoute, Link } from '@tanstack/react-router';
import { useMutation as useConvexMutation, useQuery as useConvexQuery } from 'convex/react';
import { useState } from 'react';
import { DashboardAuthRequiredState } from '@/components/dashboard/AuthRequiredState';
import { useToast } from '@/components/ui/Toast';
import { YucpButton } from '@/components/ui/YucpButton';
import { useActiveDashboardContext } from '@/hooks/useActiveDashboardContext';
import { useDashboardSession } from '@/hooks/useDashboardSession';
import { useDashboardShell } from '@/hooks/useDashboardShell';
import { api } from '../../../../../../convex/_generated/api';
import type { Id } from '../../../../../../convex/_generated/dataModel';

export const Route = createLazyFileRoute('/_authenticated/dashboard/setup')({
  component: DashboardSetupRoute,
});

type SetupLandingState = 'new' | 'resume' | 'already_set_up' | 'needs_attention' | 'migration';

const STEP_TITLE: Record<string, string> = {
  connect_store: 'Connect your store',
  scan_server: 'Checking your server',
  generate_plan: 'Building your setup plan',
  review_exceptions: 'Review your setup plan',
  apply_setup: 'Setting up your server',
  shadow_migration: 'Running migration checks',
  confirm_cutover: 'Confirm the switch',
};

const STEP_DESCRIPTION: Record<string, string> = {
  connect_store:
    'YUCP needs to see your products so it can match them to Discord roles. If you have already connected a store, click Continue below.',
  scan_server:
    'YUCP is looking at your current Discord roles and channels. This happens automatically and usually takes a few seconds.',
  generate_plan:
    "YUCP is figuring out which products should match which roles. You don't need to do anything right now.",
  review_exceptions:
    'Here is exactly what YUCP will do when you click Apply. Read through each change, then confirm at the bottom of the page.',
  apply_setup:
    'YUCP is creating roles and setting up the verification message in your Discord server. This usually takes under a minute.',
  shadow_migration:
    'YUCP is running silent checks to make sure existing members keep their access during the switch.',
  confirm_cutover:
    'Everything looks good. Confirm to make YUCP the active system for verification on this server.',
};

const AUTOMATIC_PHASES = new Set([
  'scan_server',
  'generate_plan',
  'apply_setup',
  'shadow_migration',
]);

type MigrationModeKey =
  | 'adopt_existing_roles'
  | 'import_verified_users'
  | 'bridge_from_current_roles';

const MIGRATION_MODE_INFO: Record<MigrationModeKey, { title: string; description: string }> = {
  adopt_existing_roles: {
    title: 'Use your existing roles',
    description:
      'You already have Discord roles that match your products. YUCP will connect them to your store without creating duplicates or confusing your members.',
  },
  import_verified_users: {
    title: 'Import who already has access',
    description:
      "Carry over your current members' access so no one loses their role during the switch.",
  },
  bridge_from_current_roles: {
    title: 'Migrate gradually',
    description:
      'Keep your current bot running while YUCP handles new verifications. You can cut over whenever you are ready.',
  },
};

const MIGRATION_MODE_LABEL: Record<string, string> = {
  adopt_existing_roles: 'Using existing roles',
  import_verified_users: 'Importing verified users',
  bridge_from_current_roles: 'Migrating gradually',
  cross_server_bridge: 'Cross-server bridge',
};

const MIGRATION_PHASE_LABEL: Record<string, string> = {
  analyze: 'Analyzing your server',
  shadow_migration: 'Running alongside your current bot',
  confirm_cutover: 'Ready to switch over',
};

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function formatDate(value: number | null): string {
  return value ? DATE_FORMATTER.format(value) : 'Not yet recorded';
}

function getWizardStep(phase: string): { current: number; total: number } {
  if (phase === 'connect_store') return { current: 1, total: 3 };
  if (phase === 'scan_server' || phase === 'generate_plan') return { current: 2, total: 3 };
  return { current: 3, total: 3 };
}

function deriveSetupLandingState({
  setupJob,
  setupSummary,
  migrationJob,
}: {
  setupJob:
    | {
        job: {
          status: string;
          blockingReason?: string | null;
        };
      }
    | null
    | undefined;
  setupSummary:
    | {
        enabledRoleRuleCount: number;
        verificationPromptLive: boolean;
        lastCompletedSetupAt: number | null;
      }
    | null
    | undefined;
  migrationJob:
    | {
        job: {
          status: string;
        };
      }
    | null
    | undefined;
}): SetupLandingState {
  if (setupJob && (setupJob.job.status === 'blocked' || setupJob.job.status === 'failed')) {
    return 'needs_attention';
  }

  if (
    setupJob &&
    setupJob.job.status !== 'completed' &&
    setupJob.job.status !== 'failed' &&
    setupJob.job.status !== 'cancelled'
  ) {
    return 'resume';
  }

  // Active migration job without a concurrent setup job takes the migration path.
  if (
    migrationJob &&
    migrationJob.job.status !== 'completed' &&
    migrationJob.job.status !== 'failed' &&
    migrationJob.job.status !== 'cancelled'
  ) {
    return 'migration';
  }

  if (
    setupSummary &&
    (setupSummary.enabledRoleRuleCount > 0 ||
      setupSummary.verificationPromptLive ||
      setupSummary.lastCompletedSetupAt !== null)
  ) {
    return 'already_set_up';
  }

  return 'new';
}

// ─── SetupStartView ──────────────────────────────────────────────────────────

function SetupStartView({
  connectedStoreCount,
  onStart,
  isStarting,
  onStartMigration,
  isStartingMigration,
}: {
  connectedStoreCount: number;
  onStart: () => void;
  isStarting: boolean;
  onStartMigration: (mode: MigrationModeKey) => void;
  isStartingMigration: boolean;
}) {
  const [showMigration, setShowMigration] = useState(false);
  const [selectedMode, setSelectedMode] = useState<MigrationModeKey | null>(null);

  return (
    <>
      <section className="intg-card animate-in animate-in-delay-1" aria-label="Start setup">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-zinc-500 dark:text-zinc-400">
            Server setup
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-zinc-950 dark:text-white">
            Set up product verification for this server
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-600 dark:text-zinc-300">
            YUCP connects your store to Discord. When a member buys something, YUCP checks their
            purchase and gives them the right role, automatically.
          </p>
        </div>

        <div className="mt-6 grid gap-3 lg:grid-cols-3">
          <div className="rounded-[14px] border border-zinc-200 bg-zinc-50/90 p-4 dark:border-white/10 dark:bg-white/5">
            <p className="text-sm font-semibold text-zinc-900 dark:text-white">
              1. Connect your store
            </p>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
              Link your Gumroad, itch.io, or other store so YUCP can see your products.
            </p>
          </div>
          <div className="rounded-[14px] border border-zinc-200 bg-zinc-50/90 p-4 dark:border-white/10 dark:bg-white/5">
            <p className="text-sm font-semibold text-zinc-900 dark:text-white">
              2. YUCP matches products to roles
            </p>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
              YUCP suggests which Discord role each product should give. You approve the plan.
            </p>
          </div>
          <div className="rounded-[14px] border border-zinc-200 bg-zinc-50/90 p-4 dark:border-white/10 dark:bg-white/5">
            <p className="text-sm font-semibold text-zinc-900 dark:text-white">
              3. Apply and you&apos;re done
            </p>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
              YUCP creates any missing roles and sets up the verification message for your server.
            </p>
          </div>
        </div>

        <div className="mt-5 rounded-[14px] border border-zinc-200 bg-zinc-50/90 p-4 dark:border-white/10 dark:bg-white/5">
          <p className="text-sm font-semibold text-zinc-900 dark:text-white">
            Before you begin, make sure you have:
          </p>
          <ul className="mt-2 flex flex-col gap-1.5">
            <li className="flex items-start gap-2 text-sm text-zinc-600 dark:text-zinc-300">
              <span className="mt-0.5 shrink-0 text-zinc-400 dark:text-zinc-500">-</span>
              Admin permission in this Discord server
            </li>
            <li className="flex items-start gap-2 text-sm text-zinc-600 dark:text-zinc-300">
              <span className="mt-0.5 shrink-0 text-zinc-400 dark:text-zinc-500">-</span>
              The YUCP bot installed and given its own role in Discord
            </li>
            <li className="flex items-start gap-2 text-sm text-zinc-600 dark:text-zinc-300">
              <span className="mt-0.5 shrink-0 text-zinc-400 dark:text-zinc-500">-</span>
              Your store login details ready (Gumroad, itch.io, etc.)
            </li>
          </ul>
        </div>

        {connectedStoreCount > 0 ? (
          <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-300">
            You already have{' '}
            <span className="font-semibold text-zinc-900 dark:text-white">
              {String(connectedStoreCount)} store{connectedStoreCount !== 1 ? 's' : ''}
            </span>{' '}
            connected, setup will pick {connectedStoreCount === 1 ? 'it' : 'them'} up automatically.
          </p>
        ) : null}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <YucpButton yucp="primary" pill isLoading={isStarting} onPress={onStart}>
            {isStarting ? 'Starting...' : 'Start setup'}
          </YucpButton>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Takes about 5 minutes.</p>
        </div>
      </section>

      {/* Migration path */}
      <section
        className="intg-card animate-in animate-in-delay-2"
        aria-label="Switching from another bot"
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-2xl">
            <h2 className="text-base font-semibold text-zinc-900 dark:text-white">
              Switching from another bot?
            </h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
              If you already have Discord roles or verified members from a different bot, YUCP can
              adopt them so nothing breaks during the switch.
            </p>
          </div>
          {!showMigration ? (
            <button
              type="button"
              className="inline-flex shrink-0 items-center rounded-full border border-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-50 dark:border-white/10 dark:text-zinc-200 dark:hover:bg-white/5"
              onClick={() => setShowMigration(true)}
            >
              Start migration
            </button>
          ) : null}
        </div>

        {showMigration ? (
          <div className="mt-5 flex flex-col gap-3">
            <p className="text-sm font-semibold text-zinc-900 dark:text-white">
              How do you want to migrate?
            </p>
            <ul className="flex flex-col gap-2">
              {(Object.keys(MIGRATION_MODE_INFO) as MigrationModeKey[]).map((mode) => {
                const info = MIGRATION_MODE_INFO[mode];
                const isSelected = selectedMode === mode;
                return (
                  <li key={mode}>
                    <button
                      type="button"
                      onClick={() => setSelectedMode(mode)}
                      aria-pressed={isSelected}
                      className={[
                        'w-full rounded-[14px] border p-4 text-left transition',
                        isSelected
                          ? 'border-zinc-950 bg-zinc-950 dark:border-white dark:bg-white'
                          : 'border-zinc-200 bg-zinc-50/90 hover:bg-zinc-100/70 dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10',
                      ].join(' ')}
                    >
                      <p
                        className={[
                          'text-sm font-semibold',
                          isSelected
                            ? 'text-white dark:text-zinc-950'
                            : 'text-zinc-900 dark:text-white',
                        ].join(' ')}
                      >
                        {info.title}
                      </p>
                      <p
                        className={[
                          'mt-1 text-sm',
                          isSelected
                            ? 'text-zinc-300 dark:text-zinc-700'
                            : 'text-zinc-600 dark:text-zinc-300',
                        ].join(' ')}
                      >
                        {info.description}
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>

            <div className="mt-1 flex flex-wrap items-center gap-3">
              <YucpButton
                yucp="primary"
                pill
                isDisabled={selectedMode === null}
                isLoading={isStartingMigration}
                onPress={() => {
                  if (selectedMode) onStartMigration(selectedMode);
                }}
              >
                {isStartingMigration ? 'Starting migration...' : 'Start migration'}
              </YucpButton>
              <button
                type="button"
                className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                onClick={() => {
                  setShowMigration(false);
                  setSelectedMode(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </>
  );
}

const TYPE_LABEL: Record<string, string> = {
  role_creation: 'Create new role',
  role_adoption: 'Use existing role',
  role_plan_entry: 'Role mapping',
  verify_surface_creation: 'Create verification message',
  verify_surface_reuse: 'Keep existing verification message',
  provider_connection: 'Store connection',
  migration_action: 'Migration step',
};

type RolePlanEntryPayload = {
  productId: string;
  productName: string;
  provider: string;
  action: 'create_role' | 'adopt_role' | 'skip';
  proposedRoleName: string;
  proposedRoleId?: string;
  availableGuildRoles?: { id: string; name: string; position: number }[];
  userOverride?: {
    action: 'create_role' | 'adopt_role' | 'skip';
    targetRoleId?: string;
    targetRoleName?: string;
  };
};

function RolePlanEntryRow({
  rec,
  onOverride,
}: {
  rec: {
    id: string;
    title: string;
    detail?: string | null;
    payload?: RolePlanEntryPayload;
  };
  onOverride: (
    recId: string,
    action: 'create_role' | 'adopt_role' | 'skip',
    targetRoleId?: string
  ) => void;
}) {
  const ep = rec.payload;
  if (!ep) return null;

  const effectiveAction = ep.userOverride?.action ?? ep.action;
  const effectiveRoleId = ep.userOverride?.targetRoleId ?? ep.proposedRoleId;
  const availableRoles = ep.availableGuildRoles ?? [];

  function handleSelectChange(value: string) {
    if (value === '__skip__') {
      onOverride(rec.id, 'skip');
    } else if (value === '__create__') {
      onOverride(rec.id, 'create_role');
    } else {
      onOverride(rec.id, 'adopt_role', value);
    }
  }

  const selectValue =
    effectiveAction === 'skip'
      ? '__skip__'
      : effectiveAction === 'create_role'
        ? '__create__'
        : (effectiveRoleId ?? '__create__');

  return (
    <li className="rounded-[14px] border border-zinc-200 bg-zinc-50/90 p-4 dark:border-white/10 dark:bg-white/5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-full border border-zinc-200 px-2 py-0.5 text-xs font-semibold text-zinc-500 dark:border-white/10 dark:text-zinc-400">
              {ep.provider}
            </span>
          </div>
          <p className="mt-1.5 text-sm font-semibold text-zinc-900 dark:text-white">
            {ep.productName}
          </p>
          {rec.detail && effectiveAction !== 'skip' ? (
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{rec.detail}</p>
          ) : null}
          {effectiveAction === 'skip' ? (
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              This product will be skipped.
            </p>
          ) : null}
        </div>
        <div className="sm:w-64">
          <label
            htmlFor={`role-plan-${rec.id}`}
            className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400"
          >
            Assign to role
          </label>
          <select
            id={`role-plan-${rec.id}`}
            value={selectValue}
            onChange={(e) => handleSelectChange(e.target.value)}
            className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:border-white/10 dark:bg-zinc-800 dark:text-white dark:focus:ring-zinc-500"
          >
            <option value="__create__">Create new role: {ep.proposedRoleName}</option>
            {availableRoles.map((r) => (
              <option key={r.id} value={r.id}>
                Use existing: {r.name}
              </option>
            ))}
            <option value="__skip__">Skip this product</option>
          </select>
        </div>
      </div>
    </li>
  );
}

function RecommendationList({
  recommendations,
  onApply,
  onOverrideRolePlanEntry,
  isApplying,
}: {
  recommendations: {
    id: string;
    status: string;
    recommendationType: string;
    title: string;
    detail?: string | null;
    payload?: unknown;
  }[];
  onApply: (dismissedIds: string[]) => void;
  onOverrideRolePlanEntry: (
    recId: string,
    action: 'create_role' | 'adopt_role' | 'skip',
    targetRoleId?: string
  ) => void;
  isApplying: boolean;
}) {
  const proposed = recommendations.filter(
    (r) => r.status === 'proposed' && r.recommendationType !== 'role_plan_entry'
  );
  const planEntries = recommendations.filter(
    (r) =>
      (r.status === 'proposed' || r.status === 'applied') &&
      r.recommendationType === 'role_plan_entry'
  );
  const applied = recommendations.filter(
    (r) => r.status === 'applied' && r.recommendationType !== 'role_plan_entry'
  );

  // Track which proposed recommendations are checked (included). Default: all checked.
  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const r of proposed) initial[r.id] = true;
    return initial;
  });

  const selectedCount = Object.values(checked).filter(Boolean).length;
  const dismissedIds = proposed.filter((r) => !checked[r.id]).map((r) => r.id);

  function toggle(id: string) {
    setChecked((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <div className="mt-5 flex flex-col gap-3">
      {planEntries.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">
            Role mapping plan
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Review how each product will be mapped to a Discord role. Use the dropdown to adopt an
            existing role, create a new one, or skip a product.
          </p>
          <ul className="flex flex-col gap-2">
            {planEntries.map((rec) => (
              <RolePlanEntryRow
                key={rec.id}
                rec={rec as Parameters<typeof RolePlanEntryRow>[0]['rec']}
                onOverride={onOverrideRolePlanEntry}
              />
            ))}
          </ul>
        </div>
      ) : null}

      {proposed.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">
            What will happen when you click Apply
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Uncheck anything you do not want YUCP to do right now. You can always run setup again
            later.
          </p>
          <ul className="flex flex-col gap-2">
            {proposed.map((rec) => {
              const isChecked = checked[rec.id] ?? true;
              return (
                <li key={rec.id}>
                  <button
                    type="button"
                    onClick={() => toggle(rec.id)}
                    aria-pressed={isChecked}
                    className={[
                      'w-full rounded-[14px] border p-4 text-left transition',
                      isChecked
                        ? 'border-zinc-200 bg-zinc-50/90 dark:border-white/10 dark:bg-white/5'
                        : 'border-zinc-100 bg-zinc-50/40 opacity-50 dark:border-white/5 dark:bg-white/[0.02]',
                    ].join(' ')}
                  >
                    <div className="flex items-start gap-3">
                      <span
                        className={[
                          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                          isChecked
                            ? 'border-zinc-950 bg-zinc-950 dark:border-white dark:bg-white'
                            : 'border-zinc-300 bg-white dark:border-zinc-600 dark:bg-zinc-800',
                        ].join(' ')}
                        aria-hidden="true"
                      >
                        {isChecked ? (
                          <svg
                            aria-hidden="true"
                            className="h-2.5 w-2.5 text-white dark:text-zinc-950"
                            viewBox="0 0 10 8"
                            fill="none"
                          >
                            <path
                              d="M1 4l3 3 5-6"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        ) : null}
                      </span>
                      <div className="flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="inline-flex items-center rounded-full border border-zinc-200 px-2 py-0.5 text-xs font-semibold text-zinc-500 dark:border-white/10 dark:text-zinc-400">
                            {TYPE_LABEL[rec.recommendationType] ?? rec.recommendationType}
                          </span>
                        </div>
                        <p className="mt-2 text-sm font-semibold text-zinc-900 dark:text-white">
                          {rec.title}
                        </p>
                        {rec.detail ? (
                          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
                            {rec.detail}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {applied.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">
            Already applied
          </p>
          <ul className="flex flex-col gap-2">
            {applied.map((rec) => (
              <li
                key={rec.id}
                className="rounded-[14px] border border-emerald-200 bg-emerald-50/90 p-4 dark:border-emerald-500/30 dark:bg-emerald-500/10"
              >
                <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-100">
                  {rec.title}
                </p>
                {rec.detail ? (
                  <p className="mt-1 text-sm text-emerald-700 dark:text-emerald-300">
                    {rec.detail}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {proposed.length === 0 && applied.length === 0 && planEntries.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          No changes were planned for this server. You can still apply to confirm the setup is
          complete.
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-4">
        <YucpButton
          yucp="primary"
          pill
          isLoading={isApplying}
          onPress={() => onApply(dismissedIds)}
        >
          {isApplying
            ? 'Applying...'
            : selectedCount > 0
              ? `Apply ${String(selectedCount)} change${selectedCount !== 1 ? 's' : ''}`
              : 'Confirm setup (no new changes)'}
        </YucpButton>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          You can adjust individual role mappings in{' '}
          <Link
            to="/dashboard/server-rules"
            search={(prev) => prev}
            className="font-semibold text-zinc-700 underline-offset-2 hover:underline dark:text-zinc-300"
          >
            Server Rules
          </Link>{' '}
          after setup completes.
        </p>
      </div>
    </div>
  );
}

// ─── SetupActiveView (step-by-step wizard) ───────────────────────────────────

function SetupActiveView({
  setupJob,
  connectedStoreCount,
  onResume,
  isResuming,
  onApply,
  isApplying,
  onOverrideRolePlanEntry,
}: {
  setupJob: {
    job: { status: string; currentPhase: string; blockingReason?: string | null };
    steps: { id: string; status: string; label: string }[];
    recommendations: {
      id: string;
      status: string;
      recommendationType: string;
      title: string;
      detail?: string | null;
      payload?: unknown;
    }[];
    activeMigrationJobId?: string | null;
  };
  connectedStoreCount: number;
  onResume: () => void;
  isResuming: boolean;
  onApply: (dismissedIds: string[]) => void;
  isApplying: boolean;
  onOverrideRolePlanEntry: (
    recId: string,
    action: 'create_role' | 'adopt_role' | 'skip',
    targetRoleId?: string
  ) => void;
}) {
  const currentPhase = setupJob.job.currentPhase;
  const { current: stepNum, total: stepTotal } = getWizardStep(currentPhase);
  const stepTitle = STEP_TITLE[currentPhase] ?? 'Setup in progress';
  const stepDescription = STEP_DESCRIPTION[currentPhase] ?? 'YUCP is working on this step.';
  const isAutomatic = AUTOMATIC_PHASES.has(currentPhase);
  const canApply =
    setupJob.job.status === 'waiting_for_user' && currentPhase === 'review_exceptions';
  const storeReady = currentPhase === 'connect_store' && connectedStoreCount > 0;

  return (
    <section className="intg-card animate-in animate-in-delay-1" aria-label="Setup step">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-2xl flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-full border border-zinc-200 px-2.5 py-0.5 text-xs font-semibold text-zinc-600 dark:border-white/10 dark:text-zinc-300">
              Step {String(stepNum)} of {String(stepTotal)}
            </span>
            {isAutomatic ? (
              <span className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2.5 py-0.5 text-xs font-semibold text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300">
                Running automatically
              </span>
            ) : null}
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-950 dark:text-white">
            {stepTitle}
          </h1>
          <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
            {stepDescription}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {storeReady ? (
            <YucpButton yucp="primary" pill isLoading={isResuming} onPress={onResume}>
              {isResuming ? 'Continuing...' : 'Continue to next step'}
            </YucpButton>
          ) : null}
          {!isAutomatic && !canApply && !storeReady ? (
            <YucpButton yucp="primary" pill isLoading={isResuming} onPress={onResume}>
              {isResuming ? 'Resuming...' : 'Continue'}
            </YucpButton>
          ) : null}
        </div>
      </div>

      {currentPhase === 'connect_store' && !storeReady ? (
        <div className="mt-5 rounded-[14px] border border-zinc-200 bg-zinc-50/90 p-4 dark:border-white/10 dark:bg-white/5">
          <p className="text-sm font-semibold text-zinc-900 dark:text-white">
            No stores connected yet
          </p>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
            Go to store connections, link at least one store, then come back here and click
            Continue.
          </p>
          <div className="mt-3">
            <Link
              to="/dashboard/integrations"
              search={(prev) => prev}
              className="inline-flex items-center rounded-full bg-zinc-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
            >
              Go to store connections
            </Link>
          </div>
        </div>
      ) : null}

      {storeReady ? (
        <div className="mt-5 rounded-[14px] border border-emerald-200 bg-emerald-50/90 p-4 dark:border-emerald-500/30 dark:bg-emerald-500/10">
          <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">
            {String(connectedStoreCount)} store{connectedStoreCount !== 1 ? 's' : ''} connected
          </p>
          <p className="mt-1 text-sm text-emerald-700 dark:text-emerald-300">
            YUCP will use {connectedStoreCount === 1 ? 'this store' : 'these stores'} to match
            products to roles. Click Continue to move to the next step.
          </p>
        </div>
      ) : null}

      {isAutomatic ? (
        <div className="mt-5 flex items-center gap-3 rounded-[14px] border border-zinc-200 bg-zinc-50/90 px-4 py-3 dark:border-white/10 dark:bg-white/5">
          <div className="h-2 w-2 animate-pulse rounded-full bg-sky-500" />
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            YUCP is handling this step automatically. No action needed from you right now.
          </p>
        </div>
      ) : null}

      {canApply ? (
        <RecommendationList
          recommendations={setupJob.recommendations}
          onApply={onApply}
          onOverrideRolePlanEntry={onOverrideRolePlanEntry}
          isApplying={isApplying}
        />
      ) : null}
    </section>
  );
}

// ─── SetupMaintenanceView ────────────────────────────────────────────────────

function SetupMaintenanceView({
  connectedStoreCount,
  setupSummary,
  onRunAgain,
  isRunningAgain,
  onStartMigration,
}: {
  connectedStoreCount: number;
  setupSummary: {
    enabledRoleRuleCount: number;
    verificationPromptLive: boolean;
    lastCompletedSetupAt: number | null;
  };
  onRunAgain: () => void;
  isRunningAgain: boolean;
  onStartMigration: () => void;
}) {
  return (
    <>
      <section className="intg-card animate-in animate-in-delay-1" aria-label="Setup status">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
                Active
              </span>
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-950 dark:text-white">
              This server is already set up
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-600 dark:text-zinc-300">
              Product verification is running. When a member buys something from your store, YUCP
              checks their purchase and gives them the right role in Discord.
            </p>
          </div>
          <div className="shrink-0">
            <YucpButton yucp="secondary" pill isLoading={isRunningAgain} onPress={onRunAgain}>
              {isRunningAgain ? 'Starting...' : 'Update setup'}
            </YucpButton>
          </div>
        </div>

        <div className="mt-5 grid gap-3 lg:grid-cols-4">
          <div className="rounded-[14px] border border-zinc-200 bg-zinc-50/90 p-4 dark:border-white/10 dark:bg-white/5">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">
              Storefronts connected
            </p>
            <p className="mt-2 text-2xl font-semibold text-zinc-950 dark:text-white">
              {String(connectedStoreCount)}
            </p>
          </div>
          <div className="rounded-[14px] border border-zinc-200 bg-zinc-50/90 p-4 dark:border-white/10 dark:bg-white/5">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">
              Product-role mappings
            </p>
            <p className="mt-2 text-2xl font-semibold text-zinc-950 dark:text-white">
              {String(setupSummary.enabledRoleRuleCount)}
            </p>
          </div>
          <div className="rounded-[14px] border border-zinc-200 bg-zinc-50/90 p-4 dark:border-white/10 dark:bg-white/5">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">
              Verification message
            </p>
            <p className="mt-2 text-sm font-semibold text-zinc-900 dark:text-white">
              {setupSummary.verificationPromptLive ? 'Live' : 'Check needed'}
            </p>
          </div>
          <div className="rounded-[14px] border border-zinc-200 bg-zinc-50/90 p-4 dark:border-white/10 dark:bg-white/5">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">
              Last successful setup
            </p>
            <p className="mt-2 text-sm font-semibold text-zinc-900 dark:text-white">
              {formatDate(setupSummary.lastCompletedSetupAt)}
            </p>
          </div>
        </div>
      </section>

      <section className="intg-card animate-in animate-in-delay-2" aria-label="Make a change">
        <h2 className="intg-title">Make a change</h2>
        <p className="intg-desc">
          Update your setup at any time, add a new store, adjust which roles products give, or check
          the verification message.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            to="/dashboard/integrations"
            search={(prev) => prev}
            className="inline-flex items-center rounded-full border border-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-50 dark:border-white/10 dark:text-zinc-200 dark:hover:bg-white/5"
          >
            Add another store
          </Link>
          <Link
            to="/dashboard/server-rules"
            search={(prev) => prev}
            className="inline-flex items-center rounded-full border border-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-50 dark:border-white/10 dark:text-zinc-200 dark:hover:bg-white/5"
          >
            Update role mappings
          </Link>
          <button
            type="button"
            className="inline-flex items-center rounded-full border border-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-50 dark:border-white/10 dark:text-zinc-200 dark:hover:bg-white/5"
            onClick={onStartMigration}
          >
            Adopt roles from another bot
          </button>
        </div>
      </section>
    </>
  );
}

// ─── NeedsAttentionView ──────────────────────────────────────────────────────

type AttentionCategory =
  | 'discord_permissions'
  | 'bot_removed'
  | 'no_store'
  | 'role_hierarchy'
  | 'generic';

function classifyBlockingReason(reason: string | null | undefined): AttentionCategory {
  if (!reason) return 'generic';
  const lower = reason.toLowerCase();
  if (
    lower.includes('no longer in your discord server') ||
    lower.includes('unknownguild') ||
    lower.includes('unknown guild')
  )
    return 'bot_removed';
  if (
    lower.includes('discord permissions missing') ||
    lower.includes('missing permissions') ||
    lower.includes('manage roles') ||
    lower.includes('manage channels')
  )
    return 'discord_permissions';
  if (lower.includes('connect at least one')) return 'no_store';
  if (
    lower.includes('role hierarchy') ||
    lower.includes('cannot manage') ||
    lower.includes('canmanage')
  )
    return 'role_hierarchy';
  return 'generic';
}

const ATTENTION_FIX_STEPS: Record<AttentionCategory, { title: string; steps: string[] }> = {
  discord_permissions: {
    title: 'Fix the bot permissions in Discord',
    steps: [
      'Open your Discord server.',
      'Go to Server Settings (right-click your server icon or click the server name at the top).',
      'Click Roles in the left sidebar.',
      'Find the YUCP role in the list and click it.',
      'Scroll down and turn on "Manage Roles" and "Manage Channels".',
      'Save the changes, then come back here and click Try again.',
    ],
  },
  bot_removed: {
    title: 'Re-invite the bot to your server',
    steps: [
      'The bot was removed from your Discord server.',
      'Use the invite link from your YUCP dashboard to add the bot back.',
      'When prompted, select your server and grant the requested permissions.',
      'Once the bot is back in your server, come back here and click Try again.',
    ],
  },
  no_store: {
    title: 'Connect a store first',
    steps: [
      'YUCP needs at least one store connected before it can set up roles.',
      'Click "Connect a store" below to go to your integrations page.',
      'Connect your Gumroad, itch.io, or other store.',
      'Once connected, come back here and click Try again.',
    ],
  },
  role_hierarchy: {
    title: 'Move the YUCP bot role higher in your server',
    steps: [
      'Open your Discord server and go to Server Settings > Roles.',
      'Find the YUCP role and drag it above any roles you want YUCP to manage.',
      'Discord only lets a bot manage roles that are below its own role in the list.',
      'Save the order, then come back here and click Try again.',
    ],
  },
  generic: {
    title: 'How to fix it',
    steps: [
      'Read the message above, it describes exactly what stopped setup.',
      'Make the fix it describes. Common fixes: check bot permissions in Discord, or reconnect your store.',
      'Come back here and click Try again.',
    ],
  },
};

function NeedsAttentionView({
  blockingReason,
  onResume,
  isResuming,
}: {
  blockingReason: string | null | undefined;
  onResume: () => void;
  isResuming: boolean;
}) {
  const category = classifyBlockingReason(blockingReason);
  const fix = ATTENTION_FIX_STEPS[category];

  return (
    <section className="intg-card animate-in animate-in-delay-1" aria-label="Setup needs attention">
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-zinc-500 dark:text-zinc-400">
        Action needed
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-950 dark:text-white">
        Setup stopped, here is how to fix it
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-600 dark:text-zinc-300">
        Something went wrong. Follow the steps below, then click Try again.
      </p>

      <div className="mt-5 rounded-[14px] border border-zinc-200 bg-zinc-50/90 p-5 dark:border-white/10 dark:bg-white/5">
        <p className="text-sm font-semibold text-zinc-900 dark:text-white">{fix.title}</p>
        <ol className="mt-3 flex flex-col gap-2">
          {fix.steps.map((step) => (
            <li
              key={step}
              className="flex items-start gap-3 text-sm text-zinc-600 dark:text-zinc-300"
            >
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-xs font-bold text-zinc-700 dark:bg-white/10 dark:text-zinc-200">
                {fix.steps.indexOf(step) + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
      </div>

      {blockingReason ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300">
            Show technical details
          </summary>
          <p className="mt-2 rounded-[10px] border border-zinc-200 bg-zinc-50/90 px-3 py-2 font-mono text-xs text-zinc-600 dark:border-white/10 dark:bg-white/5 dark:text-zinc-400">
            {blockingReason}
          </p>
        </details>
      ) : null}

      <div className="mt-5 flex flex-wrap gap-2">
        <YucpButton yucp="primary" pill isLoading={isResuming} onPress={onResume}>
          {isResuming ? 'Starting...' : 'I fixed it - try again'}
        </YucpButton>
        {category === 'no_store' ? (
          <Link
            to="/dashboard/integrations"
            search={(prev) => prev}
            className="inline-flex items-center rounded-full border border-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-50 dark:border-white/10 dark:text-zinc-200 dark:hover:bg-white/5"
          >
            Connect a store
          </Link>
        ) : null}
      </div>
    </section>
  );
}

// ─── MigrationActiveView ─────────────────────────────────────────────────────

function MigrationActiveView({
  migrationJob,
}: {
  migrationJob: {
    job: {
      mode: string;
      status: string;
      currentPhase: string;
      blockingReason?: string | null;
      sourceBotKey?: string | null;
    };
    sources: { id: string; sourceKey: string; displayName?: string | null; status: string }[];
    roleMappings: {
      id: string;
      sourceRoleName: string;
      status: string;
      confidence?: number | null;
    }[];
  };
}) {
  const { job, sources, roleMappings } = migrationJob;
  const phaseLabel = MIGRATION_PHASE_LABEL[job.currentPhase] ?? job.currentPhase;
  const modeLabel = MIGRATION_MODE_LABEL[job.mode] ?? job.mode;
  const isWaiting = job.status === 'waiting_for_user';
  const isBlocked = job.status === 'blocked' || job.status === 'failed';
  const pendingMappings = roleMappings.filter((m) => m.status === 'pending_review');
  const confirmedMappings = roleMappings.filter((m) => m.status !== 'pending_review');

  return (
    <section className="intg-card animate-in animate-in-delay-1" aria-label="Migration in progress">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-2xl">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2.5 py-0.5 text-xs font-semibold text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300">
              Migration in progress
            </span>
            <span className="inline-flex items-center rounded-full border border-zinc-200 px-2.5 py-0.5 text-xs font-semibold text-zinc-600 dark:border-white/10 dark:text-zinc-300">
              {modeLabel}
            </span>
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-950 dark:text-white">
            {phaseLabel}
          </h1>
          <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
            {job.currentPhase === 'analyze'
              ? 'YUCP is scanning your server roles and matching them to your store products. This happens automatically.'
              : job.currentPhase === 'shadow_migration'
                ? 'YUCP is running alongside your current bot. Your members keep their access while YUCP verifies everything looks right.'
                : 'YUCP has finished analyzing. Review the plan below, then confirm to complete the switch.'}
          </p>
        </div>

        {!isBlocked && job.currentPhase !== 'confirm_cutover' ? (
          <div className="flex items-center gap-3 rounded-[14px] border border-zinc-200 bg-zinc-50/90 px-4 py-3 dark:border-white/10 dark:bg-white/5">
            <div className="h-2 w-2 animate-pulse rounded-full bg-sky-500" />
            <p className="text-sm text-zinc-600 dark:text-zinc-300">Running automatically</p>
          </div>
        ) : null}
      </div>

      {isBlocked ? (
        <div className="mt-5 rounded-[14px] border border-amber-200 bg-amber-50/90 p-4 dark:border-amber-500/30 dark:bg-amber-500/10">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700 dark:text-amber-400">
            Migration paused
          </p>
          <p className="mt-2 text-sm font-semibold text-amber-900 dark:text-amber-100">
            {job.blockingReason ?? 'Migration stopped before it could finish.'}
          </p>
        </div>
      ) : null}

      {job.currentPhase === 'confirm_cutover' && isWaiting ? (
        <div className="mt-5 rounded-[14px] border border-emerald-200 bg-emerald-50/90 p-4 dark:border-emerald-500/30 dark:bg-emerald-500/10">
          <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">
            Everything looks good
          </p>
          <p className="mt-1 text-sm text-emerald-700 dark:text-emerald-300">
            YUCP has matched your existing roles to your store products and verified your members
            still have access. To complete the switch, go to Discord and remove your old bot, then
            come back here. YUCP will take over automatically.
          </p>
        </div>
      ) : null}

      {sources.length > 0 ? (
        <div className="mt-5 flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">
            Sources detected
          </p>
          <ul className="flex flex-col gap-1.5">
            {sources.map((source) => (
              <li
                key={source.id}
                className="flex items-center gap-2 rounded-[10px] border border-zinc-200 bg-zinc-50/90 px-3 py-2 text-sm dark:border-white/10 dark:bg-white/5"
              >
                <span className="flex-1 font-medium text-zinc-900 dark:text-white">
                  {source.displayName ?? source.sourceKey}
                </span>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">{source.status}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {roleMappings.length > 0 ? (
        <div className="mt-5 flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">
            Role mappings ({String(confirmedMappings.length)} matched
            {pendingMappings.length > 0 ? `, ${String(pendingMappings.length)} need review` : ''})
          </p>
          <ul className="flex flex-col gap-1.5">
            {roleMappings.slice(0, 8).map((mapping) => (
              <li
                key={mapping.id}
                className="flex items-center gap-2 rounded-[10px] border border-zinc-200 bg-zinc-50/90 px-3 py-2 text-sm dark:border-white/10 dark:bg-white/5"
              >
                <span className="flex-1 font-medium text-zinc-900 dark:text-white">
                  {mapping.sourceRoleName}
                </span>
                {mapping.confidence !== null && mapping.confidence !== undefined ? (
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    {String(Math.round(mapping.confidence * 100))}% match
                  </span>
                ) : null}
                <span
                  className={[
                    'text-xs font-medium',
                    mapping.status === 'pending_review'
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-emerald-600 dark:text-emerald-400',
                  ].join(' ')}
                >
                  {mapping.status === 'pending_review' ? 'Needs review' : 'Matched'}
                </span>
              </li>
            ))}
            {roleMappings.length > 8 ? (
              <li className="px-3 py-1 text-xs text-zinc-500 dark:text-zinc-400">
                +{String(roleMappings.length - 8)} more
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

// ─── Main route ──────────────────────────────────────────────────────────────

function DashboardSetupRoute() {
  const { activeGuildId, isPersonalDashboard } = useActiveDashboardContext();
  const { status } = useDashboardSession();
  const { home } = useDashboardShell();
  const toast = useToast();

  const setupJob = useConvexQuery(
    api.setupJobs.getMySetupJobForGuild,
    activeGuildId ? { guildId: activeGuildId } : 'skip'
  );
  const setupSummary = useConvexQuery(
    api.setupJobs.getMySetupSummaryByGuild,
    activeGuildId ? { guildId: activeGuildId } : 'skip'
  );
  const migrationJob = useConvexQuery(
    api.setupJobs.getMyLatestMigrationJobForGuild,
    activeGuildId ? { guildId: activeGuildId } : 'skip'
  );

  const createOrResumeSetupJob = useConvexMutation(api.setupJobs.createOrResumeSetupJobByGuild);
  const applyRecommendedSetup = useConvexMutation(api.setupJobs.applyRecommendedSetupByGuild);
  const createMigrationJob = useConvexMutation(api.setupJobs.createMigrationJobByGuild);
  const overrideRolePlanEntry = useConvexMutation(api.setupJobs.overrideRolePlanEntry);

  const [isResuming, setIsResuming] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [isStartingMigration, setIsStartingMigration] = useState(false);

  const connectedStoreCount = (home?.userAccounts ?? []).filter(
    (account) => account.connectionType !== 'verification'
  ).length;

  async function handleStartOrResume() {
    if (!activeGuildId) return;
    setIsResuming(true);
    try {
      const result = await createOrResumeSetupJob({
        guildId: activeGuildId,
        mode: 'automatic_setup',
        triggerSource: 'dashboard',
      });
      toast.success(result.created ? 'Setup started' : 'Setup resumed', {
        description: result.created
          ? 'YUCP is keeping track of your progress. Come back at any time.'
          : 'Your existing setup progress is active again.',
      });
    } catch (error) {
      toast.error('Could not start setup', {
        description:
          error instanceof Error ? error.message : 'YUCP could not start setup for this server.',
      });
    } finally {
      setIsResuming(false);
    }
  }

  async function handleApply(dismissedIds: string[]) {
    if (!activeGuildId) return;
    setIsApplying(true);
    try {
      await applyRecommendedSetup({
        guildId: activeGuildId,
        dismissedIds:
          dismissedIds.length > 0 ? (dismissedIds as Id<'setup_recommendations'>[]) : undefined,
      });
      toast.success('Setup changes are on the way', {
        description:
          'YUCP is now creating any missing roles, saving product mappings, and updating the verification message.',
      });
    } catch (error) {
      toast.error('Could not apply setup changes', {
        description:
          error instanceof Error
            ? error.message
            : 'YUCP could not queue the setup changes for this server.',
      });
    } finally {
      setIsApplying(false);
    }
  }

  async function handleOverrideRolePlanEntry(
    recId: string,
    action: 'create_role' | 'adopt_role' | 'skip',
    targetRoleId?: string
  ) {
    try {
      await overrideRolePlanEntry({
        recommendationId: recId as Id<'setup_recommendations'>,
        action,
        ...(targetRoleId ? { targetRoleId } : {}),
      });
    } catch {
      toast.error('Could not save role mapping', {
        description: 'Your change may not have been saved. Please try again.',
      });
    }
  }

  async function handleStartMigration(mode: MigrationModeKey) {
    if (!activeGuildId) return;
    setIsStartingMigration(true);
    try {
      await createMigrationJob({ guildId: activeGuildId, mode });
      toast.success('Migration started', {
        description:
          'YUCP is analyzing your server and matching your existing roles to your store products.',
      });
    } catch (error) {
      toast.error('Could not start migration', {
        description:
          error instanceof Error
            ? error.message
            : 'YUCP could not start migration for this server.',
      });
    } finally {
      setIsStartingMigration(false);
    }
  }

  if (status === 'signed_out' || status === 'expired') {
    return (
      <div className="pb-16">
        <DashboardAuthRequiredState
          title="Sign in to continue setup"
          description="Your session has expired. Please sign in again to keep configuring this server."
        />
      </div>
    );
  }

  if (isPersonalDashboard || !activeGuildId) {
    return (
      <div className="pb-16">
        <section className="intg-card">
          <div className="intg-copy">
            <h2 className="intg-title">Server setup</h2>
            <p className="intg-desc">
              Select a server from the sidebar to continue. This page only works for a specific
              Discord server.
            </p>
          </div>
        </section>
      </div>
    );
  }

  const isLoading =
    setupJob === undefined || setupSummary === undefined || migrationJob === undefined;

  if (isLoading) {
    return (
      <div className="pb-16">
        <section className="intg-card" aria-busy="true" aria-label="Loading setup">
          <div className="intg-copy">
            <h1 className="intg-title">Loading setup</h1>
            <p className="intg-desc">Getting the latest setup status for this server.</p>
          </div>
        </section>
      </div>
    );
  }

  const landingState = deriveSetupLandingState({ setupJob, setupSummary, migrationJob });

  return (
    <div className="flex flex-col gap-5 pb-16">
      {landingState === 'new' ? (
        <SetupStartView
          connectedStoreCount={connectedStoreCount}
          onStart={handleStartOrResume}
          isStarting={isResuming}
          onStartMigration={handleStartMigration}
          isStartingMigration={isStartingMigration}
        />
      ) : null}

      {landingState === 'resume' && setupJob ? (
        <SetupActiveView
          setupJob={setupJob}
          connectedStoreCount={connectedStoreCount}
          onResume={handleStartOrResume}
          isResuming={isResuming}
          onApply={handleApply}
          isApplying={isApplying}
          onOverrideRolePlanEntry={handleOverrideRolePlanEntry}
        />
      ) : null}

      {landingState === 'already_set_up' && setupSummary ? (
        <SetupMaintenanceView
          connectedStoreCount={connectedStoreCount}
          setupSummary={setupSummary}
          onRunAgain={handleStartOrResume}
          isRunningAgain={isResuming}
          onStartMigration={() => void handleStartMigration('adopt_existing_roles')}
        />
      ) : null}

      {landingState === 'needs_attention' ? (
        <NeedsAttentionView
          blockingReason={setupJob?.job.blockingReason}
          onResume={handleStartOrResume}
          isResuming={isResuming}
        />
      ) : null}

      {landingState === 'migration' && migrationJob ? (
        <MigrationActiveView migrationJob={migrationJob} />
      ) : null}
    </div>
  );
}
