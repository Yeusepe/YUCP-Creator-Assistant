import { useMutation as useConvexMutation, useQuery as useConvexQuery } from 'convex/react';
import { useMemo, useState } from 'react';
import { DashboardSkeletonSwap } from '@/components/dashboard/DashboardSkeletonSwap';
import { DashboardListSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { useToast } from '@/components/ui/Toast';
import { YucpButton } from '@/components/ui/YucpButton';
import { api } from '../../../../../../convex/_generated/api';

const PHASE_LABELS: Record<string, string> = {
  connect_store: 'Connect store',
  scan_server: 'Scan server',
  generate_plan: 'Generate recommended plan',
  review_exceptions: 'Review exceptions',
  apply_setup: 'Apply setup',
  shadow_migration: 'Shadow migration',
  confirm_cutover: 'Confirm cutover',
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  in_progress: 'Running',
  running: 'Running',
  waiting_for_user: 'Needs review',
  blocked: 'Blocked',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const MIGRATION_MODE_LABELS: Record<string, string> = {
  adopt_existing_roles: 'Adopt Existing Roles',
  import_verified_users: 'Import Verified Users',
  bridge_from_current_roles: 'Bridge From Current Roles',
  cross_server_bridge: 'Cross-Server Bridge',
};

const MIGRATION_PHASE_LABELS: Record<string, string> = {
  analyze: 'Analyze',
  shadow: 'Shadow',
  bridged: 'Bridged',
  enforced: 'Enforced',
  rollback: 'Rollback',
};

function getStepStatusClasses(status: string) {
  switch (status) {
    case 'completed':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300';
    case 'in_progress':
    case 'running':
      return 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300';
    case 'waiting_for_user':
      return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300';
    case 'failed':
    case 'blocked':
      return 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300';
    default:
      return 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-white/10 dark:bg-white/5 dark:text-zinc-400';
  }
}

export function AutomaticSetupPanel({
  guildId,
  showMigrationCenter = false,
}: {
  guildId: string;
  showMigrationCenter?: boolean;
}) {
  const toast = useToast();
  const setupJob = useConvexQuery(api.setupJobs.getMySetupJobForGuild, { guildId });
  const migrationJob = useConvexQuery(api.setupJobs.getMyLatestMigrationJobForGuild, { guildId });
  const createOrResumeSetupJob = useConvexMutation(api.setupJobs.createOrResumeSetupJobByGuild);
  const applyRecommendedSetup = useConvexMutation(api.setupJobs.applyRecommendedSetupByGuild);
  const createMigrationJob = useConvexMutation(api.setupJobs.createMigrationJobByGuild);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [startingMigrationMode, setStartingMigrationMode] = useState<string | null>(null);

  const isLoading = setupJob === undefined;
  const recommendationSummary = useMemo(() => {
    if (!setupJob) {
      return { proposed: 0, applied: 0 };
    }

    return {
      proposed: setupJob.recommendations.filter(
        (recommendation) => recommendation.status === 'proposed'
      ).length,
      applied: setupJob.recommendations.filter(
        (recommendation) => recommendation.status === 'applied'
      ).length,
    };
  }, [setupJob]);

  const completedSteps = setupJob?.steps.filter((step) => step.status === 'completed').length ?? 0;
  const totalSteps = setupJob?.steps.length ?? Object.keys(PHASE_LABELS).length;
  const progressPercent = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;
  const hasActiveJob =
    setupJob &&
    setupJob.job.status !== 'completed' &&
    setupJob.job.status !== 'failed' &&
    setupJob.job.status !== 'cancelled';

  const buttonLabel = hasActiveJob ? 'Resume setup' : 'Start setup';
  const pendingLabel = hasActiveJob ? 'Resuming...' : 'Starting...';
  const canApplyRecommendedSetup =
    setupJob?.job.status === 'waiting_for_user' &&
    setupJob.job.currentPhase === 'review_exceptions';

  return (
    <section
      id="automatic-setup-panel"
      className="intg-card animate-in animate-in-delay-1"
      aria-label="Setup details"
    >
      <div className="intg-header">
        <div className="intg-title-row">
          <div className="intg-icon">
            <img src="/Icons/Point.png" alt="" />
          </div>
          <div className="intg-copy">
            <h2 className="intg-title">Setup details</h2>
            <p className="intg-desc">
              Use the next step below to start, resume, or update setup for this server. YUCP keeps
              your progress here so you can come back at any time.
            </p>
          </div>
        </div>
        <span
          className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${getStepStatusClasses(setupJob?.job.status ?? 'pending')}`}
        >
          {STATUS_LABELS[setupJob?.job.status ?? 'pending'] ?? 'Pending'}
        </span>
      </div>

      <DashboardSkeletonSwap isLoading={isLoading} skeleton={<DashboardListSkeleton rows={4} />}>
        <div className="flex flex-col gap-4">
          <div className="rounded-[16px] border border-zinc-200 bg-zinc-50/90 p-4 dark:border-white/10 dark:bg-white/5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex-1">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-zinc-900 dark:text-white">
                    {setupJob
                      ? PHASE_LABELS[setupJob.job.currentPhase]
                      : 'Ready to build a setup plan'}
                  </span>
                  {setupJob?.activeMigrationJobId ? (
                    <span className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2.5 py-0.5 text-[11px] font-semibold text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300">
                      Migration linked
                    </span>
                  ) : null}
                </div>
                <p className="text-sm text-zinc-600 dark:text-zinc-300">
                  {setupJob
                    ? `Step ${String(Math.max(completedSteps + (hasActiveJob ? 1 : 0), 1))} of ${String(totalSteps)}. ${recommendationSummary.proposed} recommendations are waiting for review.`
                    : 'Start from here to connect a store, check your current Discord roles, and build a recommended setup plan.'}
                </p>
                {setupJob?.job.blockingReason ? (
                  <p className="mt-2 text-sm font-medium text-amber-700 dark:text-amber-300">
                    {setupJob.job.blockingReason}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                {canApplyRecommendedSetup ? (
                  <YucpButton
                    yucp="primary"
                    pill
                    isLoading={isApplying}
                    onPress={async () => {
                      setIsApplying(true);
                      try {
                        await applyRecommendedSetup({ guildId });
                        toast.success('Setup changes are on the way', {
                          description:
                            'YUCP is now creating any missing roles, saving product mappings, and updating the verification message for this server.',
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
                    }}
                  >
                    {isApplying ? 'Applying...' : 'Apply recommended setup'}
                  </YucpButton>
                ) : null}
                <YucpButton
                  yucp={canApplyRecommendedSetup ? 'secondary' : 'primary'}
                  pill
                  isLoading={isSubmitting}
                  onPress={async () => {
                    setIsSubmitting(true);
                    try {
                      const result = await createOrResumeSetupJob({
                        guildId,
                        mode: 'automatic_setup',
                        triggerSource: 'dashboard',
                      });
                      toast.success(result.created ? 'Setup started' : 'Setup resumed', {
                        description: result.created
                          ? 'YUCP is now keeping track of your store connection, server scan, and setup progress.'
                          : 'Your existing setup progress is active again in this dashboard.',
                      });
                    } catch (error) {
                      toast.error('Could not start setup', {
                        description:
                          error instanceof Error
                            ? error.message
                            : 'YUCP could not start setup for this server.',
                      });
                    } finally {
                      setIsSubmitting(false);
                    }
                  }}
                >
                  {isSubmitting ? pendingLabel : buttonLabel}
                </YucpButton>
              </div>
            </div>

            <div className="mt-4">
              <div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-white/10">
                <div
                  className="h-full rounded-full bg-zinc-900 transition-all dark:bg-white"
                  style={{ width: `${String(progressPercent)}%` }}
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                <span>{String(completedSteps)} completed</span>
                <span>{recommendationSummary.applied} applied</span>
                <span>{recommendationSummary.proposed} to review</span>
              </div>
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            {(
              setupJob?.steps ??
              Object.entries(PHASE_LABELS).map(([phase, label], index) => ({
                id: `${phase}-${String(index)}`,
                phase,
                stepKey: phase,
                label,
                stepKind: 'review',
                status: 'pending',
                sortOrder: index,
                blocking: false,
                requiresUserAction: false,
              }))
            ).map((step) => (
              <div
                key={step.id}
                className="rounded-[14px] border border-zinc-200 bg-white p-3 dark:border-white/10 dark:bg-white/5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-zinc-900 dark:text-white">
                      {step.label}
                    </p>
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                      {step.requiresUserAction
                        ? 'You have one decision to make here before setup can continue.'
                        : 'YUCP handles this step for you.'}
                    </p>
                  </div>
                  <span
                    className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getStepStatusClasses(step.status)}`}
                  >
                    {STATUS_LABELS[step.status] ?? STATUS_LABELS.pending}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {showMigrationCenter ? (
            <div className="rounded-[14px] border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-white/5">
              <div className="mb-3">
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">
                  Migration tools
                </h3>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  Use this only if you are replacing another verification bot and want YUCP to help
                  you adopt existing roles carefully.
                </p>
              </div>

              {migrationJob ? (
                <div className="mb-4 rounded-[10px] border border-zinc-200 bg-zinc-50 px-3 py-3 dark:border-white/10 dark:bg-white/5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-zinc-900 dark:text-white">
                      {MIGRATION_MODE_LABELS[migrationJob.job.mode] ?? migrationJob.job.mode}
                    </span>
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getStepStatusClasses(migrationJob.job.status)}`}
                    >
                      {STATUS_LABELS[migrationJob.job.status] ?? migrationJob.job.status}
                    </span>
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      {MIGRATION_PHASE_LABELS[migrationJob.job.currentPhase] ??
                        migrationJob.job.currentPhase}
                    </span>
                  </div>
                  {migrationJob.sources.length ? (
                    <div className="mt-3 grid gap-2 lg:grid-cols-2">
                      {migrationJob.sources.map((source) => (
                        <div
                          key={source.id}
                          className="rounded-[10px] border border-zinc-200 bg-white px-3 py-2 dark:border-white/10 dark:bg-white/5"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-sm font-medium text-zinc-900 dark:text-white">
                              {source.displayName ?? source.sourceKey}
                            </p>
                            <span className="inline-flex items-center rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] font-semibold text-zinc-700 dark:border-white/10 dark:bg-white/10 dark:text-zinc-200">
                              {source.capabilityMode.replaceAll('_', ' ')}
                            </span>
                          </div>
                          {typeof source.payload?.note === 'string' ? (
                            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                              {source.payload.note}
                            </p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="grid gap-2 lg:grid-cols-2">
                {Object.entries(MIGRATION_MODE_LABELS).map(([mode, label]) => (
                  <YucpButton
                    key={mode}
                    yucp="secondary"
                    isLoading={startingMigrationMode === mode}
                    onPress={async () => {
                      setStartingMigrationMode(mode);
                      try {
                        await createMigrationJob({
                          guildId,
                          setupJobId: setupJob?.job.id,
                          mode: mode as
                            | 'adopt_existing_roles'
                            | 'import_verified_users'
                            | 'bridge_from_current_roles'
                            | 'cross_server_bridge',
                        });
                        toast.success(`${label} started`, {
                          description:
                            'YUCP is now analyzing your current setup so you can switch over carefully.',
                        });
                      } catch (error) {
                        toast.error('Could not start migration', {
                          description:
                            error instanceof Error
                              ? error.message
                              : 'YUCP could not start migration for this server.',
                        });
                      } finally {
                        setStartingMigrationMode(null);
                      }
                    }}
                  >
                    {startingMigrationMode === mode ? 'Starting...' : label}
                  </YucpButton>
                ))}
              </div>
            </div>
          ) : null}

          {setupJob?.events.length ? (
            <div className="rounded-[14px] border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-white/5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">
                  Latest setup events
                </h3>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {String(setupJob.events.length)} recent
                </span>
              </div>
              <div className="flex max-h-60 flex-col gap-2 overflow-y-auto">
                {setupJob.events.slice(0, 6).map((event) => (
                  <div
                    key={event.id}
                    className="rounded-[10px] border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-white/10 dark:bg-white/5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm text-zinc-700 dark:text-zinc-200">{event.message}</p>
                      <span
                        className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getStepStatusClasses(event.level)}`}
                      >
                        {event.level}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </DashboardSkeletonSwap>
    </section>
  );
}
