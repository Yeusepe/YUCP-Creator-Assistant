import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { requireApiSecret } from './lib/apiAuth';
import { getAuthenticatedAuthUser } from './lib/authUser';
import { ProviderV } from './lib/providers';

const SetupJobMode = v.union(v.literal('automatic_setup'), v.literal('migration'));
const SetupJobTriggerSource = v.union(
  v.literal('dashboard'),
  v.literal('discord_setup'),
  v.literal('discord_autosetup'),
  v.literal('api')
);
const SetupJobStatus = v.union(
  v.literal('pending'),
  v.literal('running'),
  v.literal('waiting_for_user'),
  v.literal('blocked'),
  v.literal('completed'),
  v.literal('failed'),
  v.literal('cancelled')
);
const SetupJobPhase = v.union(
  v.literal('connect_store'),
  v.literal('scan_server'),
  v.literal('generate_plan'),
  v.literal('review_exceptions'),
  v.literal('apply_setup'),
  v.literal('shadow_migration'),
  v.literal('confirm_cutover')
);
const SetupStepStatus = v.union(
  v.literal('pending'),
  v.literal('in_progress'),
  v.literal('waiting_for_user'),
  v.literal('completed'),
  v.literal('failed'),
  v.literal('skipped'),
  v.literal('cancelled')
);
const SetupStepKind = v.union(
  v.literal('provider_connection'),
  v.literal('server_scan'),
  v.literal('recommendation'),
  v.literal('review'),
  v.literal('apply'),
  v.literal('migration'),
  v.literal('cutover')
);
const SetupRecommendationType = v.union(
  v.literal('provider_connection'),
  v.literal('role_adoption'),
  v.literal('role_creation'),
  v.literal('role_plan_entry'),
  v.literal('verify_surface_reuse'),
  v.literal('verify_surface_creation'),
  v.literal('migration_action')
);
const SetupRecommendationStatus = v.union(
  v.literal('proposed'),
  v.literal('applied'),
  v.literal('dismissed'),
  v.literal('superseded'),
  v.literal('requires_attention')
);
const EventLevel = v.union(
  v.literal('info'),
  v.literal('success'),
  v.literal('warning'),
  v.literal('error')
);
const MigrationMode = v.union(
  v.literal('adopt_existing_roles'),
  v.literal('import_verified_users'),
  v.literal('bridge_from_current_roles'),
  v.literal('cross_server_bridge')
);
const MigrationJobStatus = v.union(
  v.literal('pending'),
  v.literal('running'),
  v.literal('waiting_for_user'),
  v.literal('blocked'),
  v.literal('completed'),
  v.literal('failed'),
  v.literal('cancelled')
);
const MigrationPhase = v.union(
  v.literal('analyze'),
  v.literal('shadow'),
  v.literal('bridged'),
  v.literal('enforced'),
  v.literal('rollback')
);
const MigrationSourceType = v.union(
  v.literal('verification_bot'),
  v.literal('server_export'),
  v.literal('manual_snapshot')
);
const MigrationCapabilityMode = v.union(
  v.literal('full_export'),
  v.literal('partial_export'),
  v.literal('analysis_only'),
  v.literal('manual_review')
);
const MigrationSourceStatus = v.union(
  v.literal('detected'),
  v.literal('connected'),
  v.literal('imported'),
  v.literal('failed')
);
const MigrationMatchStrategy = v.union(
  v.literal('exact_name'),
  v.literal('alias'),
  v.literal('permalink'),
  v.literal('fuzzy'),
  v.literal('duplicate_group'),
  v.literal('source_bot_hint'),
  v.literal('manual')
);
const MigrationRoleMappingStatus = v.union(
  v.literal('auto_matched'),
  v.literal('suggested'),
  v.literal('unresolved'),
  v.literal('adopted'),
  v.literal('ignored')
);
const MigrationGrantStatus = v.union(
  v.literal('canonical'),
  v.literal('provisional_migration'),
  v.literal('revoked')
);
const Provider = ProviderV;

const TERMINAL_SETUP_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const DEFAULT_SETUP_FLOW: ReadonlyArray<{
  phase:
    | 'connect_store'
    | 'scan_server'
    | 'generate_plan'
    | 'review_exceptions'
    | 'apply_setup'
    | 'shadow_migration'
    | 'confirm_cutover';
  stepKey: string;
  label: string;
  stepKind:
    | 'provider_connection'
    | 'server_scan'
    | 'recommendation'
    | 'review'
    | 'apply'
    | 'migration'
    | 'cutover';
  requiresUserAction: boolean;
}> = [
  {
    phase: 'connect_store',
    stepKey: 'connect-store',
    label: 'Connect store',
    stepKind: 'provider_connection',
    requiresUserAction: true,
  },
  {
    phase: 'scan_server',
    stepKey: 'scan-server',
    label: 'Scan server',
    stepKind: 'server_scan',
    requiresUserAction: false,
  },
  {
    phase: 'generate_plan',
    stepKey: 'generate-plan',
    label: 'Generate recommended plan',
    stepKind: 'recommendation',
    requiresUserAction: false,
  },
  {
    phase: 'review_exceptions',
    stepKey: 'review-exceptions',
    label: 'Review exceptions',
    stepKind: 'review',
    requiresUserAction: true,
  },
  {
    phase: 'apply_setup',
    stepKey: 'apply-setup',
    label: 'Apply setup',
    stepKind: 'apply',
    requiresUserAction: false,
  },
  {
    phase: 'shadow_migration',
    stepKey: 'shadow-migration',
    label: 'Shadow migration',
    stepKind: 'migration',
    requiresUserAction: false,
  },
  {
    phase: 'confirm_cutover',
    stepKey: 'confirm-cutover',
    label: 'Confirm cutover',
    stepKind: 'cutover',
    requiresUserAction: true,
  },
];

const MIGRATION_SOURCE_CAPABILITY_DEFAULTS: ReadonlyArray<{
  sourceKey: string;
  sourceType: 'server_export' | 'manual_snapshot';
  capabilityMode: 'analysis_only' | 'manual_review';
  displayName: string;
  payload?: Record<string, unknown>;
}> = [
  {
    sourceKey: 'existing-discord-state',
    sourceType: 'server_export',
    capabilityMode: 'analysis_only',
    displayName: 'Existing Discord state snapshot',
    payload: {
      note: 'Adopt existing roles, channels, and member-role state without assuming they are canonical entitlements.',
    },
  },
  {
    sourceKey: 'manual-review-fallback',
    sourceType: 'manual_snapshot',
    capabilityMode: 'manual_review',
    displayName: 'Manual review fallback',
    payload: {
      note: 'Use manual review when a legacy verification bot cannot export enough state for direct import.',
    },
  },
];

const SetupStepSummaryV = v.object({
  id: v.id('setup_job_steps'),
  phase: SetupJobPhase,
  stepKey: v.string(),
  label: v.string(),
  stepKind: SetupStepKind,
  status: SetupStepStatus,
  sortOrder: v.number(),
  blocking: v.boolean(),
  requiresUserAction: v.boolean(),
  provider: v.optional(Provider),
  payload: v.optional(v.any()),
  result: v.optional(v.any()),
  errorSummary: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
  startedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
});

const SetupRecommendationSummaryV = v.object({
  id: v.id('setup_recommendations'),
  recommendationType: SetupRecommendationType,
  status: SetupRecommendationStatus,
  confidence: v.optional(v.number()),
  title: v.string(),
  detail: v.optional(v.string()),
  payload: v.optional(v.any()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const SetupEventSummaryV = v.object({
  id: v.id('setup_events'),
  level: EventLevel,
  eventType: v.string(),
  message: v.string(),
  payload: v.optional(v.any()),
  createdAt: v.number(),
});

const SetupJobSummaryV = v.object({
  id: v.id('setup_jobs'),
  guildLinkId: v.id('guild_links'),
  discordGuildId: v.string(),
  mode: SetupJobMode,
  triggerSource: SetupJobTriggerSource,
  status: SetupJobStatus,
  currentPhase: SetupJobPhase,
  activeStepKey: v.optional(v.string()),
  blockingReason: v.optional(v.string()),
  summary: v.optional(v.any()),
  latestEventAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
  startedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
  cancelledAt: v.optional(v.number()),
  failedAt: v.optional(v.number()),
  lastResumedAt: v.optional(v.number()),
});

const SetupJobDetailV = v.object({
  job: SetupJobSummaryV,
  steps: v.array(SetupStepSummaryV),
  recommendations: v.array(SetupRecommendationSummaryV),
  events: v.array(SetupEventSummaryV),
  activeMigrationJobId: v.union(v.id('migration_jobs'), v.null()),
});

const MigrationJobSummaryV = v.object({
  id: v.id('migration_jobs'),
  setupJobId: v.optional(v.id('setup_jobs')),
  guildLinkId: v.id('guild_links'),
  discordGuildId: v.string(),
  mode: MigrationMode,
  status: MigrationJobStatus,
  currentPhase: MigrationPhase,
  sourceBotKey: v.optional(v.string()),
  sourceGuildId: v.optional(v.string()),
  blockingReason: v.optional(v.string()),
  summary: v.optional(v.any()),
  createdAt: v.number(),
  updatedAt: v.number(),
  startedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
  cancelledAt: v.optional(v.number()),
  failedAt: v.optional(v.number()),
});

const MigrationEventSummaryV = v.object({
  id: v.id('migration_events'),
  phase: v.optional(MigrationPhase),
  level: EventLevel,
  eventType: v.string(),
  message: v.string(),
  payload: v.optional(v.any()),
  createdAt: v.number(),
});

const MigrationSourceSummaryV = v.object({
  id: v.id('migration_sources'),
  sourceKey: v.string(),
  sourceType: MigrationSourceType,
  capabilityMode: MigrationCapabilityMode,
  status: MigrationSourceStatus,
  displayName: v.optional(v.string()),
  payload: v.optional(v.any()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const MigrationRoleMappingSummaryV = v.object({
  id: v.id('migration_role_mappings'),
  provider: v.optional(Provider),
  sourceRoleId: v.optional(v.string()),
  sourceRoleName: v.string(),
  targetProductId: v.optional(v.string()),
  targetProductName: v.optional(v.string()),
  targetRoleId: v.optional(v.string()),
  targetRoleName: v.optional(v.string()),
  matchStrategy: MigrationMatchStrategy,
  confidence: v.optional(v.number()),
  status: MigrationRoleMappingStatus,
  reviewNote: v.optional(v.string()),
  payload: v.optional(v.any()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const MigrationGrantSummaryV = v.object({
  id: v.id('migration_grants'),
  discordUserId: v.string(),
  roleId: v.string(),
  roleName: v.optional(v.string()),
  productId: v.optional(v.string()),
  status: MigrationGrantStatus,
  provenance: v.optional(v.any()),
  expiresAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
  promotedAt: v.optional(v.number()),
  revokedAt: v.optional(v.number()),
});

const MigrationJobDetailV = v.object({
  job: MigrationJobSummaryV,
  sources: v.array(MigrationSourceSummaryV),
  roleMappings: v.array(MigrationRoleMappingSummaryV),
  grants: v.array(MigrationGrantSummaryV),
  events: v.array(MigrationEventSummaryV),
});

const SetupGuildSummaryV = v.object({
  guildLinkId: v.id('guild_links'),
  botPresent: v.boolean(),
  enabledRoleRuleCount: v.number(),
  verificationPromptLive: v.boolean(),
  lastCompletedSetupAt: v.union(v.number(), v.null()),
});

async function getOwnedGuildLinkOrThrow(
  ctx: Pick<MutationCtx, 'db'>,
  guildLinkId: Id<'guild_links'>,
  authUserId: string
): Promise<Doc<'guild_links'>> {
  const guildLink = await ctx.db.get(guildLinkId);
  if (!guildLink) {
    throw new ConvexError('Guild link not found');
  }
  if (guildLink.authUserId !== authUserId) {
    throw new ConvexError('Unauthorized');
  }
  return guildLink;
}

async function createSetupSteps(
  ctx: Pick<MutationCtx, 'db'>,
  args: {
    setupJobId: Id<'setup_jobs'>;
    authUserId: string;
    guildLinkId: Id<'guild_links'>;
    discordGuildId: string;
    now: number;
  }
) {
  await Promise.all(
    DEFAULT_SETUP_FLOW.map((step, index) =>
      ctx.db.insert('setup_job_steps', {
        setupJobId: args.setupJobId,
        authUserId: args.authUserId,
        guildLinkId: args.guildLinkId,
        discordGuildId: args.discordGuildId,
        phase: step.phase,
        stepKey: step.stepKey,
        label: step.label,
        stepKind: step.stepKind,
        status: index === 0 ? 'in_progress' : 'pending',
        sortOrder: index,
        blocking: step.requiresUserAction,
        requiresUserAction: step.requiresUserAction,
        createdAt: args.now,
        updatedAt: args.now,
        startedAt: index === 0 ? args.now : undefined,
      })
    )
  );
}

async function seedInitialSetupRecommendations(
  ctx: Pick<MutationCtx, 'db'>,
  args: {
    setupJobId: Id<'setup_jobs'>;
    authUserId: string;
    guildLink: Doc<'guild_links'>;
    now: number;
  }
) {
  const [providerConnections, roleRules] = await Promise.all([
    ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .collect(),
    ctx.db
      .query('role_rules')
      .withIndex('by_auth_user_guild', (q) =>
        q.eq('authUserId', args.authUserId).eq('guildId', args.guildLink.discordGuildId)
      )
      .collect(),
  ]);

  const activeSetupConnections = providerConnections.filter(
    (connection) =>
      connection.status !== 'disconnected' && connection.connectionType !== 'verification'
  );
  const enabledRoleRules = roleRules.filter((roleRule) => roleRule.enabled);
  const recommendations: Array<{
    recommendationType:
      | 'provider_connection'
      | 'role_adoption'
      | 'role_creation'
      | 'verify_surface_reuse'
      | 'verify_surface_creation';
    title: string;
    detail?: string;
    status: 'proposed' | 'applied';
    payload?: Record<string, unknown>;
  }> = [];

  if (activeSetupConnections.length === 0) {
    recommendations.push({
      recommendationType: 'provider_connection',
      title: 'Connect a storefront',
      detail: 'Start by linking at least one store so the setup engine can discover products.',
      status: 'proposed',
      payload: {
        connectedCount: 0,
      },
    });
  } else {
    recommendations.push({
      recommendationType: 'provider_connection',
      title: 'Reuse existing storefront connections',
      detail: `${String(activeSetupConnections.length)} connected storefront${activeSetupConnections.length === 1 ? '' : 's'} detected for this creator.`,
      status: 'applied',
      payload: {
        providerKeys: activeSetupConnections.map((connection) => connection.provider),
      },
    });
  }

  if (enabledRoleRules.length > 0) {
    recommendations.push({
      recommendationType: 'role_adoption',
      title: 'Reuse existing role rules',
      detail: `${String(enabledRoleRules.length)} enabled role rule${enabledRoleRules.length === 1 ? '' : 's'} already exist for this server.`,
      status: 'applied',
      payload: {
        ruleCount: enabledRoleRules.length,
      },
    });
  } else {
    recommendations.push({
      recommendationType: 'role_creation',
      title: 'Create product roles from the recommended plan',
      detail:
        'No role rules exist yet, so the automatic setup job will create them after store scan.',
      status: 'proposed',
    });
  }

  if (args.guildLink.verifyPromptMessage) {
    recommendations.push({
      recommendationType: 'verify_surface_reuse',
      title: 'Reuse the current verify prompt',
      detail:
        'The server already has a saved verify prompt message that can be adopted by the new setup flow.',
      status: 'applied',
      payload: {
        channelId: args.guildLink.verifyPromptMessage.channelId,
        messageId: args.guildLink.verifyPromptMessage.messageId,
      },
    });
  } else {
    recommendations.push({
      recommendationType: 'verify_surface_creation',
      title: 'Create a dedicated verify surface',
      detail:
        'No saved verify prompt is linked yet, so the setup job will provision one during apply setup.',
      status: 'proposed',
    });
  }

  await Promise.all(
    recommendations.map((recommendation) =>
      ctx.db.insert('setup_recommendations', {
        setupJobId: args.setupJobId,
        authUserId: args.authUserId,
        guildLinkId: args.guildLink._id,
        discordGuildId: args.guildLink.discordGuildId,
        recommendationType: recommendation.recommendationType,
        status: recommendation.status,
        title: recommendation.title,
        detail: recommendation.detail,
        payload: recommendation.payload,
        createdAt: args.now,
        updatedAt: args.now,
      })
    )
  );

  await ctx.db.insert('setup_events', {
    setupJobId: args.setupJobId,
    authUserId: args.authUserId,
    guildLinkId: args.guildLink._id,
    discordGuildId: args.guildLink.discordGuildId,
    level: 'info',
    eventType: 'setup.job.seeded',
    message: 'Automatic setup analyzed existing connections, role rules, and verify surface state.',
    createdAt: args.now,
  });

  const summary = {
    providerConnectionCount: activeSetupConnections.length,
    roleRuleCount: enabledRoleRules.length,
    verifyPromptPresent: Boolean(args.guildLink.verifyPromptMessage),
    proposedRecommendationCount: recommendations.filter(
      (recommendation) => recommendation.status === 'proposed'
    ).length,
    appliedRecommendationCount: recommendations.filter(
      (recommendation) => recommendation.status === 'applied'
    ).length,
  };

  await ctx.db.patch(args.setupJobId, {
    latestEventAt: args.now,
    summary,
    updatedAt: args.now,
  });

  return summary;
}

async function upsertSetupStepRecord(
  ctx: Pick<MutationCtx, 'db'>,
  args: {
    setupJobId: Id<'setup_jobs'>;
    stepKey: string;
    status:
      | 'pending'
      | 'in_progress'
      | 'waiting_for_user'
      | 'completed'
      | 'failed'
      | 'skipped'
      | 'cancelled';
    payload?: Record<string, unknown>;
    result?: Record<string, unknown>;
    errorSummary?: string;
  }
) {
  const existing = await ctx.db
    .query('setup_job_steps')
    .withIndex('by_setup_job_step', (q) =>
      q.eq('setupJobId', args.setupJobId).eq('stepKey', args.stepKey)
    )
    .first();
  if (!existing) {
    throw new ConvexError(`Setup step not found: ${args.stepKey}`);
  }

  const now = Date.now();
  await ctx.db.patch(existing._id, {
    status: args.status,
    payload: args.payload,
    result: args.result,
    errorSummary: args.errorSummary,
    updatedAt: now,
    startedAt:
      args.status === 'in_progress' && existing.startedAt === undefined ? now : existing.startedAt,
    completedAt:
      args.status === 'completed' || args.status === 'failed' || args.status === 'skipped'
        ? now
        : existing.completedAt,
  });
}

async function synchronizeSetupJobLifecycle(
  ctx: Pick<MutationCtx, 'db'>,
  args: {
    setupJobId: Id<'setup_jobs'>;
    setupJobAuthUserId: string;
    setupJobGuildLinkId: Id<'guild_links'>;
    setupJobDiscordGuildId: string;
    recommendationSummary: {
      providerConnectionCount: number;
      roleRuleCount: number;
      verifyPromptPresent: boolean;
      proposedRecommendationCount: number;
      appliedRecommendationCount: number;
    };
  }
) {
  const now = Date.now();
  const hasConnectedStorefront = args.recommendationSummary.providerConnectionCount > 0;

  if (!hasConnectedStorefront) {
    await Promise.all([
      upsertSetupStepRecord(ctx, {
        setupJobId: args.setupJobId,
        stepKey: 'connect-store',
        status: 'waiting_for_user',
        result: { providerConnectionCount: 0 },
      }),
      upsertSetupStepRecord(ctx, {
        setupJobId: args.setupJobId,
        stepKey: 'scan-server',
        status: 'pending',
      }),
      upsertSetupStepRecord(ctx, {
        setupJobId: args.setupJobId,
        stepKey: 'generate-plan',
        status: 'pending',
      }),
      upsertSetupStepRecord(ctx, {
        setupJobId: args.setupJobId,
        stepKey: 'review-exceptions',
        status: 'pending',
      }),
    ]);

    await ctx.db.patch(args.setupJobId, {
      status: 'waiting_for_user',
      currentPhase: 'connect_store',
      activeStepKey: 'connect-store',
      blockingReason: 'Connect at least one storefront before the setup job can generate a plan.',
      updatedAt: now,
    });
    return;
  }

  await Promise.all([
    upsertSetupStepRecord(ctx, {
      setupJobId: args.setupJobId,
      stepKey: 'connect-store',
      status: 'completed',
      result: { providerConnectionCount: args.recommendationSummary.providerConnectionCount },
    }),
    upsertSetupStepRecord(ctx, {
      setupJobId: args.setupJobId,
      stepKey: 'scan-server',
      status: 'completed',
      result: {
        roleRuleCount: args.recommendationSummary.roleRuleCount,
        verifyPromptPresent: args.recommendationSummary.verifyPromptPresent,
      },
    }),
    upsertSetupStepRecord(ctx, {
      setupJobId: args.setupJobId,
      stepKey: 'generate-plan',
      status: 'in_progress',
    }),
    upsertSetupStepRecord(ctx, {
      setupJobId: args.setupJobId,
      stepKey: 'review-exceptions',
      status: 'pending',
    }),
  ]);

  await ctx.db.patch(args.setupJobId, {
    status: 'running',
    currentPhase: 'generate_plan',
    activeStepKey: 'generate-plan',
    blockingReason: undefined,
    updatedAt: now,
  });

  await enqueueSetupGeneratePlanOutboxJob(ctx, {
    setupJobId: args.setupJobId,
    authUserId: args.setupJobAuthUserId,
    guildLinkId: args.setupJobGuildLinkId,
    guildId: args.setupJobDiscordGuildId,
  });
}

async function enqueueSetupApplyOutboxJob(
  ctx: Pick<MutationCtx, 'db'>,
  args: {
    setupJobId: Id<'setup_jobs'>;
    authUserId: string;
    guildLinkId: Id<'guild_links'>;
    guildId: string;
    skipRoleProvisioning?: boolean;
    skipVerifyPrompt?: boolean;
  }
) {
  const payload = {
    setupJobId: args.setupJobId,
    guildLinkId: args.guildLinkId,
    guildId: args.guildId,
    ...(args.skipRoleProvisioning ? { skipRoleProvisioning: true } : {}),
    ...(args.skipVerifyPrompt ? { skipVerifyPrompt: true } : {}),
  };

  const existing = await ctx.db
    .query('outbox_jobs')
    .withIndex('by_idempotency', (q) => q.eq('idempotencyKey', `setup_apply:${args.setupJobId}`))
    .first();

  if (existing && existing.status !== 'failed' && existing.status !== 'dead_letter') {
    return existing._id;
  }

  const now = Date.now();
  if (existing) {
    await ctx.db.patch(existing._id, {
      status: 'pending',
      payload,
      targetGuildId: args.guildId,
      retryCount: 0,
      lastError: undefined,
      nextRetryAt: undefined,
      updatedAt: now,
    });
    return existing._id;
  }

  return ctx.db.insert('outbox_jobs', {
    authUserId: args.authUserId,
    jobType: 'setup_apply',
    payload,
    status: 'pending',
    idempotencyKey: `setup_apply:${args.setupJobId}`,
    targetGuildId: args.guildId,
    retryCount: 0,
    maxRetries: 5,
    createdAt: now,
    updatedAt: now,
  });
}

async function enqueueSetupGeneratePlanOutboxJob(
  ctx: Pick<MutationCtx, 'db'>,
  args: {
    setupJobId: Id<'setup_jobs'>;
    authUserId: string;
    guildLinkId: Id<'guild_links'>;
    guildId: string;
  }
) {
  const idempotencyKey = `setup_generate_plan:${args.setupJobId}`;
  const existing = await ctx.db
    .query('outbox_jobs')
    .withIndex('by_idempotency', (q) => q.eq('idempotencyKey', idempotencyKey))
    .first();

  if (existing && existing.status !== 'failed' && existing.status !== 'dead_letter') {
    return existing._id;
  }

  const now = Date.now();
  const payload = {
    setupJobId: args.setupJobId,
    guildLinkId: args.guildLinkId,
    guildId: args.guildId,
  };

  if (existing) {
    await ctx.db.patch(existing._id, {
      status: 'pending',
      payload,
      targetGuildId: args.guildId,
      retryCount: 0,
      lastError: undefined,
      nextRetryAt: undefined,
      updatedAt: now,
    });
    return existing._id;
  }

  return ctx.db.insert('outbox_jobs', {
    authUserId: args.authUserId,
    jobType: 'setup_generate_plan',
    payload,
    status: 'pending',
    idempotencyKey,
    targetGuildId: args.guildId,
    retryCount: 0,
    maxRetries: 5,
    createdAt: now,
    updatedAt: now,
  });
}

async function enqueueMigrationAnalyzeOutboxJob(
  ctx: Pick<MutationCtx, 'db'>,
  args: {
    migrationJobId: Id<'migration_jobs'>;
    authUserId: string;
    guildLinkId: Id<'guild_links'>;
    guildId: string;
    mode: 'adopt_existing_roles' | 'import_verified_users' | 'bridge_from_current_roles';
    sourceBotKey?: string;
    sourceGuildId?: string;
  }
) {
  const idempotencyKey = `migration_analyze:${args.migrationJobId}`;
  const existing = await ctx.db
    .query('outbox_jobs')
    .withIndex('by_idempotency', (q) => q.eq('idempotencyKey', idempotencyKey))
    .first();

  const now = Date.now();
  const payload = {
    migrationJobId: args.migrationJobId,
    guildLinkId: args.guildLinkId,
    guildId: args.guildId,
    mode: args.mode,
    sourceBotKey: args.sourceBotKey,
    sourceGuildId: args.sourceGuildId,
  };

  if (existing) {
    await ctx.db.patch(existing._id, {
      status: 'pending',
      payload,
      targetGuildId: args.guildId,
      retryCount: 0,
      lastError: undefined,
      nextRetryAt: undefined,
      updatedAt: now,
    });
    return existing._id;
  }

  return ctx.db.insert('outbox_jobs', {
    authUserId: args.authUserId,
    jobType: 'migration_analyze',
    payload,
    status: 'pending',
    idempotencyKey,
    targetGuildId: args.guildId,
    retryCount: 0,
    maxRetries: 5,
    createdAt: now,
    updatedAt: now,
  });
}

async function appendAuditEvent(
  ctx: Pick<MutationCtx, 'db'>,
  args: {
    authUserId: string;
    eventType:
      | 'setup.job.created'
      | 'setup.job.resumed'
      | 'setup.job.status.updated'
      | 'migration.job.created'
      | 'migration.job.status.updated';
    metadata?: Record<string, unknown>;
  }
) {
  await ctx.db.insert('audit_events', {
    authUserId: args.authUserId,
    eventType: args.eventType,
    actorType: 'admin',
    metadata: args.metadata,
    createdAt: Date.now(),
  });
}

async function createOrResumeSetupJobImpl(
  ctx: Pick<MutationCtx, 'db'>,
  args: {
    authUserId: string;
    guildLinkId: Id<'guild_links'>;
    mode: 'automatic_setup' | 'migration';
    triggerSource: 'dashboard' | 'discord_setup' | 'discord_autosetup' | 'api';
  }
) {
  const guildLink = await getOwnedGuildLinkOrThrow(ctx, args.guildLinkId, args.authUserId);
  const existing = await ctx.db
    .query('setup_jobs')
    .withIndex('by_guild_link', (q) => q.eq('guildLinkId', args.guildLinkId))
    .order('desc')
    .first();

  if (existing && existing.mode === args.mode && !TERMINAL_SETUP_STATUSES.has(existing.status)) {
    const now = Date.now();
    await ctx.db.patch(existing._id, {
      triggerSource: args.triggerSource,
      lastResumedAt: now,
      updatedAt: now,
    });
    await appendAuditEvent(ctx, {
      authUserId: args.authUserId,
      eventType: 'setup.job.resumed',
      metadata: {
        setupJobId: existing._id,
        guildLinkId: args.guildLinkId,
        triggerSource: args.triggerSource,
      },
    });

    // If the job is still waiting for a storefront connection, check whether providers
    // are now connected and advance the lifecycle into the generate_plan phase.
    if (existing.currentPhase === 'connect_store' && existing.status === 'waiting_for_user') {
      const [providerConnections, roleRules] = await Promise.all([
        ctx.db
          .query('provider_connections')
          .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
          .collect(),
        ctx.db
          .query('role_rules')
          .withIndex('by_auth_user_guild', (q) =>
            q.eq('authUserId', args.authUserId).eq('guildId', guildLink.discordGuildId)
          )
          .collect(),
      ]);
      const activeConnections = providerConnections.filter(
        (c) => c.status !== 'disconnected' && c.connectionType !== 'verification'
      );
      if (activeConnections.length > 0) {
        const enabledRules = roleRules.filter((r) => r.enabled);
        await synchronizeSetupJobLifecycle(ctx, {
          setupJobId: existing._id,
          setupJobAuthUserId: args.authUserId,
          setupJobGuildLinkId: guildLink._id,
          setupJobDiscordGuildId: guildLink.discordGuildId,
          recommendationSummary: {
            providerConnectionCount: activeConnections.length,
            roleRuleCount: enabledRules.length,
            verifyPromptPresent: !!guildLink.verifyPromptMessage,
            proposedRecommendationCount: 1,
            appliedRecommendationCount: enabledRules.length > 0 ? 1 : 0,
          },
        });
      }
    }

    return { setupJobId: existing._id, created: false as const };
  }

  const now = Date.now();
  const setupJobId = await ctx.db.insert('setup_jobs', {
    authUserId: args.authUserId,
    guildLinkId: args.guildLinkId,
    discordGuildId: guildLink.discordGuildId,
    mode: args.mode,
    triggerSource: args.triggerSource,
    status: 'pending',
    currentPhase: 'connect_store',
    activeStepKey: 'connect-store',
    createdAt: now,
    updatedAt: now,
    startedAt: now,
  });

  await createSetupSteps(ctx, {
    setupJobId,
    authUserId: args.authUserId,
    guildLinkId: args.guildLinkId,
    discordGuildId: guildLink.discordGuildId,
    now,
  });
  const recommendationSummary = await seedInitialSetupRecommendations(ctx, {
    setupJobId,
    authUserId: args.authUserId,
    guildLink,
    now,
  });
  await synchronizeSetupJobLifecycle(ctx, {
    setupJobId,
    setupJobAuthUserId: args.authUserId,
    setupJobGuildLinkId: guildLink._id,
    setupJobDiscordGuildId: guildLink.discordGuildId,
    recommendationSummary,
  });

  await appendAuditEvent(ctx, {
    authUserId: args.authUserId,
    eventType: 'setup.job.created',
    metadata: {
      setupJobId,
      guildLinkId: args.guildLinkId,
      mode: args.mode,
      triggerSource: args.triggerSource,
    },
  });

  return { setupJobId, created: true as const };
}

async function createMigrationJobImpl(
  ctx: Pick<MutationCtx, 'db'>,
  args: {
    authUserId: string;
    guildLinkId: Id<'guild_links'>;
    setupJobId?: Id<'setup_jobs'>;
    mode:
      | 'adopt_existing_roles'
      | 'import_verified_users'
      | 'bridge_from_current_roles'
      | 'cross_server_bridge';
    sourceBotKey?: string;
    sourceGuildId?: string;
  }
) {
  const guildLink = await getOwnedGuildLinkOrThrow(ctx, args.guildLinkId, args.authUserId);
  if (args.setupJobId) {
    const setupJob = await ctx.db.get(args.setupJobId);
    if (!setupJob || setupJob.authUserId !== args.authUserId) {
      throw new ConvexError('Setup job not found');
    }
  }

  const now = Date.now();
  const migrationJobId = await ctx.db.insert('migration_jobs', {
    authUserId: args.authUserId,
    setupJobId: args.setupJobId,
    guildLinkId: args.guildLinkId,
    discordGuildId: guildLink.discordGuildId,
    mode: args.mode,
    status: 'running',
    currentPhase: 'analyze',
    sourceBotKey: args.sourceBotKey,
    sourceGuildId: args.sourceGuildId,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
  });

  for (const source of MIGRATION_SOURCE_CAPABILITY_DEFAULTS) {
    await ctx.db.insert('migration_sources', {
      migrationJobId,
      authUserId: args.authUserId,
      guildLinkId: args.guildLinkId,
      sourceKey: source.sourceKey,
      sourceType: source.sourceType,
      capabilityMode: source.capabilityMode,
      status: 'detected',
      displayName: source.displayName,
      payload: source.payload,
      createdAt: now,
      updatedAt: now,
    });
  }
  if (args.sourceBotKey) {
    await ctx.db.insert('migration_sources', {
      migrationJobId,
      authUserId: args.authUserId,
      guildLinkId: args.guildLinkId,
      sourceKey: args.sourceBotKey,
      sourceType: 'verification_bot',
      capabilityMode: 'analysis_only',
      status: 'detected',
      displayName: args.sourceBotKey,
      payload: {
        note: 'Legacy verification bots default to analysis-only until an adapter proves export support.',
      },
      createdAt: now,
      updatedAt: now,
    });
  }

  await appendAuditEvent(ctx, {
    authUserId: args.authUserId,
    eventType: 'migration.job.created',
    metadata: {
      migrationJobId,
      setupJobId: args.setupJobId,
      guildLinkId: args.guildLinkId,
      mode: args.mode,
    },
  });

  if (args.mode !== 'cross_server_bridge') {
    await enqueueMigrationAnalyzeOutboxJob(ctx, {
      migrationJobId,
      authUserId: args.authUserId,
      guildLinkId: args.guildLinkId,
      guildId: guildLink.discordGuildId,
      mode: args.mode,
      sourceBotKey: args.sourceBotKey,
      sourceGuildId: args.sourceGuildId,
    });
  }

  return { migrationJobId };
}

async function getOwnedGuildLinkByDiscordGuildId(
  ctx: Pick<MutationCtx, 'db'>,
  args: {
    authUserId: string;
    guildId: string;
  }
) {
  const guildLink = await ctx.db
    .query('guild_links')
    .withIndex('by_discord_guild', (q) => q.eq('discordGuildId', args.guildId))
    .first();
  if (!guildLink || guildLink.authUserId !== args.authUserId) {
    throw new ConvexError('Guild link not found');
  }
  return guildLink;
}

export const createOrResumeSetupJob = mutation({
  args: {
    guildLinkId: v.id('guild_links'),
    mode: SetupJobMode,
    triggerSource: SetupJobTriggerSource,
  },
  returns: v.object({
    setupJobId: v.id('setup_jobs'),
    created: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const authUser = await getAuthenticatedAuthUser(ctx);
    if (!authUser) {
      throw new ConvexError('Unauthenticated');
    }
    return createOrResumeSetupJobImpl(ctx, {
      authUserId: authUser.authUserId,
      guildLinkId: args.guildLinkId,
      mode: args.mode,
      triggerSource: args.triggerSource,
    });
  },
});

export const createOrResumeSetupJobForOwner = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    guildLinkId: v.id('guild_links'),
    mode: SetupJobMode,
    triggerSource: SetupJobTriggerSource,
  },
  returns: v.object({
    setupJobId: v.id('setup_jobs'),
    created: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    return createOrResumeSetupJobImpl(ctx, args);
  },
});

export const createOrResumeSetupJobForOwnerByGuild = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    guildId: v.string(),
    mode: SetupJobMode,
    triggerSource: SetupJobTriggerSource,
  },
  returns: v.object({
    setupJobId: v.id('setup_jobs'),
    created: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const guildLink = await getOwnedGuildLinkByDiscordGuildId(ctx, {
      authUserId: args.authUserId,
      guildId: args.guildId,
    });
    return createOrResumeSetupJobImpl(ctx, {
      authUserId: args.authUserId,
      guildLinkId: guildLink._id,
      mode: args.mode,
      triggerSource: args.triggerSource,
    });
  },
});

export const listMySetupJobs = query({
  args: {
    guildLinkId: v.optional(v.id('guild_links')),
    includeCompleted: v.optional(v.boolean()),
  },
  returns: v.array(SetupJobSummaryV),
  handler: async (ctx, args) => {
    const authUser = await getAuthenticatedAuthUser(ctx);
    if (!authUser) {
      return [];
    }

    const jobs = args.guildLinkId
      ? await (() => {
          const guildLinkId = args.guildLinkId;
          return ctx.db
            .query('setup_jobs')
            .withIndex('by_guild_link', (q) => q.eq('guildLinkId', guildLinkId))
            .order('desc')
            .take(50);
        })()
      : await ctx.db
          .query('setup_jobs')
          .withIndex('by_auth_user', (q) => q.eq('authUserId', authUser.authUserId))
          .order('desc')
          .take(50);

    return jobs
      .filter((job) => job.authUserId === authUser.authUserId)
      .filter((job) => args.includeCompleted || !TERMINAL_SETUP_STATUSES.has(job.status))
      .map((job) => ({
        id: job._id,
        guildLinkId: job.guildLinkId,
        discordGuildId: job.discordGuildId,
        mode: job.mode,
        triggerSource: job.triggerSource,
        status: job.status,
        currentPhase: job.currentPhase,
        activeStepKey: job.activeStepKey,
        blockingReason: job.blockingReason,
        summary: job.summary,
        latestEventAt: job.latestEventAt,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        cancelledAt: job.cancelledAt,
        failedAt: job.failedAt,
        lastResumedAt: job.lastResumedAt,
      }));
  },
});

export const getSetupJob = query({
  args: {
    setupJobId: v.id('setup_jobs'),
  },
  returns: v.union(v.null(), SetupJobDetailV),
  handler: async (ctx, args) => {
    const authUser = await getAuthenticatedAuthUser(ctx);
    if (!authUser) {
      return null;
    }

    const job = await ctx.db.get(args.setupJobId);
    if (!job || job.authUserId !== authUser.authUserId) {
      return null;
    }

    const [steps, recommendations, events, activeMigrationJob] = await Promise.all([
      ctx.db
        .query('setup_job_steps')
        .withIndex('by_setup_job', (q) => q.eq('setupJobId', args.setupJobId))
        .order('asc')
        .collect(),
      ctx.db
        .query('setup_recommendations')
        .withIndex('by_setup_job', (q) => q.eq('setupJobId', args.setupJobId))
        .order('asc')
        .collect(),
      ctx.db
        .query('setup_events')
        .withIndex('by_setup_job', (q) => q.eq('setupJobId', args.setupJobId))
        .order('desc')
        .take(50),
      ctx.db
        .query('migration_jobs')
        .withIndex('by_setup_job', (q) => q.eq('setupJobId', args.setupJobId))
        .order('desc')
        .first(),
    ]);

    return {
      job: {
        id: job._id,
        guildLinkId: job.guildLinkId,
        discordGuildId: job.discordGuildId,
        mode: job.mode,
        triggerSource: job.triggerSource,
        status: job.status,
        currentPhase: job.currentPhase,
        activeStepKey: job.activeStepKey,
        blockingReason: job.blockingReason,
        summary: job.summary,
        latestEventAt: job.latestEventAt,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        cancelledAt: job.cancelledAt,
        failedAt: job.failedAt,
        lastResumedAt: job.lastResumedAt,
      },
      steps: steps.map((step) => ({
        id: step._id,
        phase: step.phase,
        stepKey: step.stepKey,
        label: step.label,
        stepKind: step.stepKind,
        status: step.status,
        sortOrder: step.sortOrder,
        blocking: step.blocking,
        requiresUserAction: step.requiresUserAction,
        provider: step.provider,
        payload: step.payload,
        result: step.result,
        errorSummary: step.errorSummary,
        createdAt: step.createdAt,
        updatedAt: step.updatedAt,
        startedAt: step.startedAt,
        completedAt: step.completedAt,
      })),
      recommendations: recommendations.map((recommendation) => ({
        id: recommendation._id,
        recommendationType: recommendation.recommendationType,
        status: recommendation.status,
        confidence: recommendation.confidence,
        title: recommendation.title,
        detail: recommendation.detail,
        payload: recommendation.payload,
        createdAt: recommendation.createdAt,
        updatedAt: recommendation.updatedAt,
      })),
      events: events.map((event) => ({
        id: event._id,
        level: event.level,
        eventType: event.eventType,
        message: event.message,
        payload: event.payload,
        createdAt: event.createdAt,
      })),
      activeMigrationJobId: activeMigrationJob?._id ?? null,
    };
  },
});

export const getMySetupJobForGuild = query({
  args: {
    guildId: v.string(),
  },
  returns: v.union(v.null(), SetupJobDetailV),
  handler: async (ctx, args) => {
    const authUser = await getAuthenticatedAuthUser(ctx);
    if (!authUser) {
      return null;
    }

    const job = await ctx.db
      .query('setup_jobs')
      .withIndex('by_auth_user_guild', (q) =>
        q.eq('authUserId', authUser.authUserId).eq('discordGuildId', args.guildId)
      )
      .order('desc')
      .first();

    if (!job) {
      return null;
    }

    const [steps, recommendations, events, activeMigrationJob] = await Promise.all([
      ctx.db
        .query('setup_job_steps')
        .withIndex('by_setup_job', (q) => q.eq('setupJobId', job._id))
        .order('asc')
        .collect(),
      ctx.db
        .query('setup_recommendations')
        .withIndex('by_setup_job', (q) => q.eq('setupJobId', job._id))
        .order('asc')
        .collect(),
      ctx.db
        .query('setup_events')
        .withIndex('by_setup_job', (q) => q.eq('setupJobId', job._id))
        .order('desc')
        .take(50),
      ctx.db
        .query('migration_jobs')
        .withIndex('by_setup_job', (q) => q.eq('setupJobId', job._id))
        .order('desc')
        .first(),
    ]);

    return {
      job: {
        id: job._id,
        guildLinkId: job.guildLinkId,
        discordGuildId: job.discordGuildId,
        mode: job.mode,
        triggerSource: job.triggerSource,
        status: job.status,
        currentPhase: job.currentPhase,
        activeStepKey: job.activeStepKey,
        blockingReason: job.blockingReason,
        summary: job.summary,
        latestEventAt: job.latestEventAt,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        cancelledAt: job.cancelledAt,
        failedAt: job.failedAt,
        lastResumedAt: job.lastResumedAt,
      },
      steps: steps.map((step) => ({
        id: step._id,
        phase: step.phase,
        stepKey: step.stepKey,
        label: step.label,
        stepKind: step.stepKind,
        status: step.status,
        sortOrder: step.sortOrder,
        blocking: step.blocking,
        requiresUserAction: step.requiresUserAction,
        provider: step.provider,
        payload: step.payload,
        result: step.result,
        errorSummary: step.errorSummary,
        createdAt: step.createdAt,
        updatedAt: step.updatedAt,
        startedAt: step.startedAt,
        completedAt: step.completedAt,
      })),
      recommendations: recommendations.map((recommendation) => ({
        id: recommendation._id,
        recommendationType: recommendation.recommendationType,
        status: recommendation.status,
        confidence: recommendation.confidence,
        title: recommendation.title,
        detail: recommendation.detail,
        payload: recommendation.payload,
        createdAt: recommendation.createdAt,
        updatedAt: recommendation.updatedAt,
      })),
      events: events.map((event) => ({
        id: event._id,
        level: event.level,
        eventType: event.eventType,
        message: event.message,
        payload: event.payload,
        createdAt: event.createdAt,
      })),
      activeMigrationJobId: activeMigrationJob?._id ?? null,
    };
  },
});

export const getMySetupSummaryByGuild = query({
  args: {
    guildId: v.string(),
  },
  returns: v.union(v.null(), SetupGuildSummaryV),
  handler: async (ctx, args) => {
    const authUser = await getAuthenticatedAuthUser(ctx);
    if (!authUser) {
      return null;
    }

    const guildLink = await ctx.db
      .query('guild_links')
      .withIndex('by_discord_guild', (q) => q.eq('discordGuildId', args.guildId))
      .first();
    if (!guildLink || guildLink.authUserId !== authUser.authUserId) {
      return null;
    }

    const [roleRules, recentSetupJobs] = await Promise.all([
      ctx.db
        .query('role_rules')
        .withIndex('by_auth_user_guild', (q) =>
          q.eq('authUserId', authUser.authUserId).eq('guildId', args.guildId)
        )
        .collect(),
      ctx.db
        .query('setup_jobs')
        .withIndex('by_auth_user_guild', (q) =>
          q.eq('authUserId', authUser.authUserId).eq('discordGuildId', args.guildId)
        )
        .order('desc')
        .take(20),
    ]);

    const latestCompletedSetupJob = recentSetupJobs.find((job) => job.status === 'completed');

    return {
      guildLinkId: guildLink._id,
      botPresent: guildLink.botPresent,
      enabledRoleRuleCount: roleRules.filter((roleRule) => roleRule.enabled).length,
      verificationPromptLive: guildLink.verifyPromptMessage !== undefined,
      lastCompletedSetupAt: latestCompletedSetupJob?.completedAt ?? null,
    };
  },
});

export const getSetupJobForOwnerByGuild = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    guildId: v.string(),
  },
  returns: v.union(v.null(), SetupJobDetailV),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const job = await ctx.db
      .query('setup_jobs')
      .withIndex('by_auth_user_guild', (q) =>
        q.eq('authUserId', args.authUserId).eq('discordGuildId', args.guildId)
      )
      .order('desc')
      .first();

    if (!job) {
      return null;
    }

    const [steps, recommendations, events, activeMigrationJob] = await Promise.all([
      ctx.db
        .query('setup_job_steps')
        .withIndex('by_setup_job', (q) => q.eq('setupJobId', job._id))
        .order('asc')
        .collect(),
      ctx.db
        .query('setup_recommendations')
        .withIndex('by_setup_job', (q) => q.eq('setupJobId', job._id))
        .order('asc')
        .collect(),
      ctx.db
        .query('setup_events')
        .withIndex('by_setup_job', (q) => q.eq('setupJobId', job._id))
        .order('desc')
        .take(50),
      ctx.db
        .query('migration_jobs')
        .withIndex('by_setup_job', (q) => q.eq('setupJobId', job._id))
        .order('desc')
        .first(),
    ]);

    return {
      job: {
        id: job._id,
        guildLinkId: job.guildLinkId,
        discordGuildId: job.discordGuildId,
        mode: job.mode,
        triggerSource: job.triggerSource,
        status: job.status,
        currentPhase: job.currentPhase,
        activeStepKey: job.activeStepKey,
        blockingReason: job.blockingReason,
        summary: job.summary,
        latestEventAt: job.latestEventAt,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        cancelledAt: job.cancelledAt,
        failedAt: job.failedAt,
        lastResumedAt: job.lastResumedAt,
      },
      steps: steps.map((step) => ({
        id: step._id,
        phase: step.phase,
        stepKey: step.stepKey,
        label: step.label,
        stepKind: step.stepKind,
        status: step.status,
        sortOrder: step.sortOrder,
        blocking: step.blocking,
        requiresUserAction: step.requiresUserAction,
        provider: step.provider,
        payload: step.payload,
        result: step.result,
        errorSummary: step.errorSummary,
        createdAt: step.createdAt,
        updatedAt: step.updatedAt,
        startedAt: step.startedAt,
        completedAt: step.completedAt,
      })),
      recommendations: recommendations.map((recommendation) => ({
        id: recommendation._id,
        recommendationType: recommendation.recommendationType,
        status: recommendation.status,
        confidence: recommendation.confidence,
        title: recommendation.title,
        detail: recommendation.detail,
        payload: recommendation.payload,
        createdAt: recommendation.createdAt,
        updatedAt: recommendation.updatedAt,
      })),
      events: events.map((event) => ({
        id: event._id,
        level: event.level,
        eventType: event.eventType,
        message: event.message,
        payload: event.payload,
        createdAt: event.createdAt,
      })),
      activeMigrationJobId: activeMigrationJob?._id ?? null,
    };
  },
});

export const createOrResumeSetupJobByGuild = mutation({
  args: {
    guildId: v.string(),
    mode: SetupJobMode,
    triggerSource: SetupJobTriggerSource,
  },
  returns: v.object({
    setupJobId: v.id('setup_jobs'),
    created: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const authUser = await getAuthenticatedAuthUser(ctx);
    if (!authUser) {
      throw new ConvexError('Unauthenticated');
    }

    const guildLink = await getOwnedGuildLinkByDiscordGuildId(ctx, {
      authUserId: authUser.authUserId,
      guildId: args.guildId,
    });

    return createOrResumeSetupJobImpl(ctx, {
      authUserId: authUser.authUserId,
      guildLinkId: guildLink._id,
      mode: args.mode,
      triggerSource: args.triggerSource,
    });
  },
});

export const applyRecommendedSetupByGuild = mutation({
  args: {
    guildId: v.string(),
    /** IDs of recommendations the user chose to skip. They will be marked as dismissed. */
    dismissedIds: v.optional(v.array(v.id('setup_recommendations'))),
  },
  returns: v.object({
    setupJobId: v.id('setup_jobs'),
    queued: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const authUser = await getAuthenticatedAuthUser(ctx);
    if (!authUser) {
      throw new ConvexError('Unauthenticated');
    }

    const guildLink = await getOwnedGuildLinkByDiscordGuildId(ctx, {
      authUserId: authUser.authUserId,
      guildId: args.guildId,
    });
    const job = await ctx.db
      .query('setup_jobs')
      .withIndex('by_auth_user_guild', (q) =>
        q.eq('authUserId', authUser.authUserId).eq('discordGuildId', args.guildId)
      )
      .order('desc')
      .first();

    if (!job) {
      throw new ConvexError('Start the setup job before applying the recommended changes.');
    }
    if (job.status === 'completed') {
      return { setupJobId: job._id, queued: false };
    }
    if (job.status === 'running' && job.currentPhase === 'apply_setup') {
      return { setupJobId: job._id, queued: false };
    }
    if (job.currentPhase === 'generate_plan') {
      throw new ConvexError(
        'The setup plan is still being built. Wait a moment and refresh, then apply when the plan appears.'
      );
    }

    const now = Date.now();

    // Dismiss any recommendations the user explicitly unchecked.
    const dismissedIds = args.dismissedIds ?? [];
    const dismissedTypes = new Set<string>();
    if (dismissedIds.length > 0) {
      await Promise.all(
        dismissedIds.map(async (recId) => {
          const rec = await ctx.db.get(recId);
          if (rec && rec.setupJobId === job._id && rec.status === 'proposed') {
            dismissedTypes.add(rec.recommendationType);
            await ctx.db.patch(recId, { status: 'dismissed', updatedAt: now });
          }
        })
      );
    }

    // Skip verify prompt if user dismissed the surface recommendation.
    // Role provisioning is handled per-entry via role_plan_entry overrides.
    const skipVerifyPrompt =
      dismissedTypes.has('verify_surface_creation') || dismissedTypes.has('verify_surface_reuse');

    await Promise.all([
      upsertSetupStepRecord(ctx, {
        setupJobId: job._id,
        stepKey: 'review-exceptions',
        status: 'completed',
      }),
      upsertSetupStepRecord(ctx, {
        setupJobId: job._id,
        stepKey: 'apply-setup',
        status: 'in_progress',
      }),
      ctx.db.patch(job._id, {
        status: 'running',
        currentPhase: 'apply_setup',
        activeStepKey: 'apply-setup',
        blockingReason: undefined,
        updatedAt: now,
      }),
      ctx.db.insert('setup_events', {
        setupJobId: job._id,
        authUserId: job.authUserId,
        guildLinkId: job.guildLinkId,
        discordGuildId: job.discordGuildId,
        level: 'info',
        eventType: 'setup.apply.queued',
        message: 'Queued the automatic setup apply step for Discord provisioning.',
        createdAt: now,
      }),
    ]);
    await ctx.db.patch(job._id, {
      latestEventAt: now,
      updatedAt: now,
    });

    await enqueueSetupApplyOutboxJob(ctx, {
      setupJobId: job._id,
      authUserId: job.authUserId,
      guildLinkId: guildLink._id,
      guildId: guildLink.discordGuildId,
      skipVerifyPrompt: skipVerifyPrompt || undefined,
    });

    return { setupJobId: job._id, queued: true };
  },
});

export const applyRecommendedSetupForOwnerByGuild = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    guildId: v.string(),
  },
  returns: v.object({
    setupJobId: v.id('setup_jobs'),
    queued: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const guildLink = await getOwnedGuildLinkByDiscordGuildId(ctx, {
      authUserId: args.authUserId,
      guildId: args.guildId,
    });
    const job = await ctx.db
      .query('setup_jobs')
      .withIndex('by_auth_user_guild', (q) =>
        q.eq('authUserId', args.authUserId).eq('discordGuildId', args.guildId)
      )
      .order('desc')
      .first();

    if (!job) {
      throw new ConvexError('Start the setup job before applying the recommended changes.');
    }
    if (job.status === 'completed') {
      return { setupJobId: job._id, queued: false };
    }
    if (job.status === 'running' && job.currentPhase === 'apply_setup') {
      return { setupJobId: job._id, queued: false };
    }

    const summary = (job.summary ?? {}) as {
      providerConnectionCount?: number;
    };
    if ((summary.providerConnectionCount ?? 0) === 0) {
      throw new ConvexError('Connect at least one storefront before applying setup.');
    }

    const now = Date.now();
    await Promise.all([
      upsertSetupStepRecord(ctx, {
        setupJobId: job._id,
        stepKey: 'review-exceptions',
        status: 'completed',
      }),
      upsertSetupStepRecord(ctx, {
        setupJobId: job._id,
        stepKey: 'apply-setup',
        status: 'in_progress',
      }),
      ctx.db.patch(job._id, {
        status: 'running',
        currentPhase: 'apply_setup',
        activeStepKey: 'apply-setup',
        blockingReason: undefined,
        updatedAt: now,
      }),
      ctx.db.insert('setup_events', {
        setupJobId: job._id,
        authUserId: job.authUserId,
        guildLinkId: job.guildLinkId,
        discordGuildId: job.discordGuildId,
        level: 'info',
        eventType: 'setup.apply.queued',
        message: 'Queued the automatic setup apply step for Discord provisioning.',
        createdAt: now,
      }),
    ]);
    await ctx.db.patch(job._id, {
      latestEventAt: now,
      updatedAt: now,
    });

    await enqueueSetupApplyOutboxJob(ctx, {
      setupJobId: job._id,
      authUserId: job.authUserId,
      guildLinkId: guildLink._id,
      guildId: guildLink.discordGuildId,
    });

    return { setupJobId: job._id, queued: true };
  },
});

export const advanceSetupToReviewExceptions = mutation({
  args: {
    apiSecret: v.string(),
    setupJobId: v.id('setup_jobs'),
    planEntryCount: v.number(),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const job = await ctx.db.get(args.setupJobId);
    if (!job) {
      throw new ConvexError('Setup job not found.');
    }

    const now = Date.now();
    await Promise.all([
      upsertSetupStepRecord(ctx, {
        setupJobId: job._id,
        stepKey: 'generate-plan',
        status: 'completed',
        result: { planEntryCount: args.planEntryCount },
      }),
      upsertSetupStepRecord(ctx, {
        setupJobId: job._id,
        stepKey: 'review-exceptions',
        status: 'waiting_for_user',
        payload: { planEntryCount: args.planEntryCount },
      }),
      ctx.db.patch(job._id, {
        status: 'waiting_for_user',
        currentPhase: 'review_exceptions',
        activeStepKey: 'review-exceptions',
        blockingReason:
          args.planEntryCount > 0
            ? 'Review how roles will be mapped for each product, then click Apply to continue.'
            : undefined,
        updatedAt: now,
      }),
      ctx.db.insert('setup_events', {
        setupJobId: job._id,
        authUserId: job.authUserId,
        guildLinkId: job.guildLinkId,
        discordGuildId: job.discordGuildId,
        level: 'info',
        eventType: 'setup.plan.generated',
        message: `Role mapping plan generated with ${args.planEntryCount} product entries.`,
        createdAt: now,
      }),
    ]);
    await ctx.db.patch(job._id, { latestEventAt: now, updatedAt: now });
    return { success: true };
  },
});

export const overrideRolePlanEntry = mutation({
  args: {
    recommendationId: v.id('setup_recommendations'),
    action: v.union(v.literal('create_role'), v.literal('adopt_role'), v.literal('skip')),
    targetRoleId: v.optional(v.string()),
    targetRoleName: v.optional(v.string()),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    const authUser = await getAuthenticatedAuthUser(ctx);
    if (!authUser) {
      throw new ConvexError('Unauthenticated');
    }

    const rec = await ctx.db.get(args.recommendationId);
    if (!rec) {
      throw new ConvexError('Recommendation not found.');
    }
    const job = await ctx.db.get(rec.setupJobId);
    if (!job || job.authUserId !== authUser.authUserId) {
      throw new ConvexError('Not authorized.');
    }

    const currentPayload = (rec.payload ?? {}) as Record<string, unknown>;
    await ctx.db.patch(args.recommendationId, {
      payload: {
        ...currentPayload,
        userOverride: {
          action: args.action,
          ...(args.targetRoleId ? { targetRoleId: args.targetRoleId } : {}),
          ...(args.targetRoleName ? { targetRoleName: args.targetRoleName } : {}),
        },
      },
      updatedAt: Date.now(),
    });
    return { success: true };
  },
});

export const getSetupRolePlanEntries = query({
  args: {
    apiSecret: v.string(),
    setupJobId: v.id('setup_jobs'),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    return ctx.db
      .query('setup_recommendations')
      .withIndex('by_setup_job', (q) => q.eq('setupJobId', args.setupJobId))
      .filter((q) => q.eq(q.field('recommendationType'), 'role_plan_entry'))
      .collect();
  },
});

export const updateSetupJobState = mutation({
  args: {
    apiSecret: v.string(),
    setupJobId: v.id('setup_jobs'),
    status: v.optional(SetupJobStatus),
    currentPhase: v.optional(SetupJobPhase),
    activeStepKey: v.optional(v.union(v.string(), v.null())),
    blockingReason: v.optional(v.union(v.string(), v.null())),
    summary: v.optional(v.any()),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const job = await ctx.db.get(args.setupJobId);
    if (!job) {
      throw new ConvexError('Setup job not found');
    }

    const now = Date.now();
    const patch: Record<string, unknown> = {
      updatedAt: now,
    };
    if (args.status !== undefined) {
      patch.status = args.status;
      if (args.status === 'completed') patch.completedAt = now;
      if (args.status === 'failed') patch.failedAt = now;
      if (args.status === 'cancelled') patch.cancelledAt = now;
    }
    if (args.currentPhase !== undefined) patch.currentPhase = args.currentPhase;
    if (args.activeStepKey !== undefined) patch.activeStepKey = args.activeStepKey ?? undefined;
    if (args.blockingReason !== undefined) patch.blockingReason = args.blockingReason ?? undefined;
    if (args.summary !== undefined) patch.summary = args.summary;

    await ctx.db.patch(args.setupJobId, patch);
    await appendAuditEvent(ctx, {
      authUserId: job.authUserId,
      eventType: 'setup.job.status.updated',
      metadata: {
        setupJobId: args.setupJobId,
        status: args.status,
        currentPhase: args.currentPhase,
      },
    });
    return { success: true };
  },
});

export const upsertSetupStep = mutation({
  args: {
    apiSecret: v.string(),
    setupJobId: v.id('setup_jobs'),
    stepKey: v.string(),
    phase: SetupJobPhase,
    label: v.string(),
    stepKind: SetupStepKind,
    status: SetupStepStatus,
    sortOrder: v.number(),
    blocking: v.boolean(),
    requiresUserAction: v.boolean(),
    provider: v.optional(Provider),
    payload: v.optional(v.any()),
    result: v.optional(v.any()),
    errorSummary: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const job = await ctx.db.get(args.setupJobId);
    if (!job) {
      throw new ConvexError('Setup job not found');
    }

    const existing = await ctx.db
      .query('setup_job_steps')
      .withIndex('by_setup_job_step', (q) =>
        q.eq('setupJobId', args.setupJobId).eq('stepKey', args.stepKey)
      )
      .first();
    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        phase: args.phase,
        label: args.label,
        stepKind: args.stepKind,
        status: args.status,
        sortOrder: args.sortOrder,
        blocking: args.blocking,
        requiresUserAction: args.requiresUserAction,
        provider: args.provider,
        payload: args.payload,
        result: args.result,
        errorSummary: args.errorSummary ?? undefined,
        updatedAt: now,
        startedAt:
          args.status === 'in_progress' && existing.startedAt === undefined
            ? now
            : existing.startedAt,
        completedAt:
          args.status === 'completed' || args.status === 'failed' || args.status === 'skipped'
            ? now
            : existing.completedAt,
      });
    } else {
      await ctx.db.insert('setup_job_steps', {
        setupJobId: args.setupJobId,
        authUserId: job.authUserId,
        guildLinkId: job.guildLinkId,
        discordGuildId: job.discordGuildId,
        phase: args.phase,
        stepKey: args.stepKey,
        label: args.label,
        stepKind: args.stepKind,
        status: args.status,
        sortOrder: args.sortOrder,
        blocking: args.blocking,
        requiresUserAction: args.requiresUserAction,
        provider: args.provider,
        payload: args.payload,
        result: args.result,
        errorSummary: args.errorSummary ?? undefined,
        createdAt: now,
        updatedAt: now,
        startedAt: args.status === 'in_progress' ? now : undefined,
        completedAt:
          args.status === 'completed' || args.status === 'failed' || args.status === 'skipped'
            ? now
            : undefined,
      });
    }

    return { success: true };
  },
});

export const upsertSetupRecommendation = mutation({
  args: {
    apiSecret: v.string(),
    setupJobId: v.id('setup_jobs'),
    recommendationType: SetupRecommendationType,
    title: v.string(),
    status: SetupRecommendationStatus,
    confidence: v.optional(v.number()),
    detail: v.optional(v.string()),
    payload: v.optional(v.any()),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const job = await ctx.db.get(args.setupJobId);
    if (!job) {
      throw new ConvexError('Setup job not found');
    }

    const now = Date.now();
    const existing = await ctx.db
      .query('setup_recommendations')
      .withIndex('by_setup_job', (q) => q.eq('setupJobId', args.setupJobId))
      .collect();
    const match = existing.find(
      (recommendation) =>
        recommendation.recommendationType === args.recommendationType &&
        recommendation.title === args.title
    );

    if (match) {
      await ctx.db.patch(match._id, {
        status: args.status,
        confidence: args.confidence,
        detail: args.detail,
        payload: args.payload,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert('setup_recommendations', {
        setupJobId: args.setupJobId,
        authUserId: job.authUserId,
        guildLinkId: job.guildLinkId,
        discordGuildId: job.discordGuildId,
        recommendationType: args.recommendationType,
        status: args.status,
        confidence: args.confidence,
        title: args.title,
        detail: args.detail,
        payload: args.payload,
        createdAt: now,
        updatedAt: now,
      });
    }

    return { success: true };
  },
});

export const appendSetupEvent = mutation({
  args: {
    apiSecret: v.string(),
    setupJobId: v.id('setup_jobs'),
    level: EventLevel,
    eventType: v.string(),
    message: v.string(),
    payload: v.optional(v.any()),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const job = await ctx.db.get(args.setupJobId);
    if (!job) {
      throw new ConvexError('Setup job not found');
    }

    const now = Date.now();
    await ctx.db.insert('setup_events', {
      setupJobId: args.setupJobId,
      authUserId: job.authUserId,
      guildLinkId: job.guildLinkId,
      discordGuildId: job.discordGuildId,
      level: args.level,
      eventType: args.eventType,
      message: args.message,
      payload: args.payload,
      createdAt: now,
    });
    await ctx.db.patch(args.setupJobId, {
      latestEventAt: now,
      updatedAt: now,
    });
    return { success: true };
  },
});

export const createMigrationJob = mutation({
  args: {
    guildLinkId: v.id('guild_links'),
    setupJobId: v.optional(v.id('setup_jobs')),
    mode: MigrationMode,
    sourceBotKey: v.optional(v.string()),
    sourceGuildId: v.optional(v.string()),
  },
  returns: v.object({
    migrationJobId: v.id('migration_jobs'),
  }),
  handler: async (ctx, args) => {
    const authUser = await getAuthenticatedAuthUser(ctx);
    if (!authUser) {
      throw new ConvexError('Unauthenticated');
    }
    return createMigrationJobImpl(ctx, {
      authUserId: authUser.authUserId,
      guildLinkId: args.guildLinkId,
      setupJobId: args.setupJobId,
      mode: args.mode,
      sourceBotKey: args.sourceBotKey,
      sourceGuildId: args.sourceGuildId,
    });
  },
});

export const createMigrationJobForOwner = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    guildLinkId: v.id('guild_links'),
    setupJobId: v.optional(v.id('setup_jobs')),
    mode: MigrationMode,
    sourceBotKey: v.optional(v.string()),
    sourceGuildId: v.optional(v.string()),
  },
  returns: v.object({
    migrationJobId: v.id('migration_jobs'),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    return createMigrationJobImpl(ctx, args);
  },
});

export const createMigrationJobByGuild = mutation({
  args: {
    guildId: v.string(),
    setupJobId: v.optional(v.id('setup_jobs')),
    mode: MigrationMode,
    sourceBotKey: v.optional(v.string()),
    sourceGuildId: v.optional(v.string()),
  },
  returns: v.object({
    migrationJobId: v.id('migration_jobs'),
  }),
  handler: async (ctx, args) => {
    const authUser = await getAuthenticatedAuthUser(ctx);
    if (!authUser) {
      throw new ConvexError('Unauthenticated');
    }

    const guildLink = await getOwnedGuildLinkByDiscordGuildId(ctx, {
      authUserId: authUser.authUserId,
      guildId: args.guildId,
    });

    return createMigrationJobImpl(ctx, {
      authUserId: authUser.authUserId,
      guildLinkId: guildLink._id,
      setupJobId: args.setupJobId,
      mode: args.mode,
      sourceBotKey: args.sourceBotKey,
      sourceGuildId: args.sourceGuildId,
    });
  },
});

export const getMigrationJob = query({
  args: {
    migrationJobId: v.id('migration_jobs'),
  },
  returns: v.union(v.null(), MigrationJobDetailV),
  handler: async (ctx, args) => {
    const authUser = await getAuthenticatedAuthUser(ctx);
    if (!authUser) {
      return null;
    }

    const job = await ctx.db.get(args.migrationJobId);
    if (!job || job.authUserId !== authUser.authUserId) {
      return null;
    }

    const [sources, roleMappings, grants, events] = await Promise.all([
      ctx.db
        .query('migration_sources')
        .withIndex('by_migration_job', (q) => q.eq('migrationJobId', args.migrationJobId))
        .order('asc')
        .collect(),
      ctx.db
        .query('migration_role_mappings')
        .withIndex('by_migration_job', (q) => q.eq('migrationJobId', args.migrationJobId))
        .order('asc')
        .collect(),
      ctx.db
        .query('migration_grants')
        .withIndex('by_migration_job', (q) => q.eq('migrationJobId', args.migrationJobId))
        .order('asc')
        .take(500),
      ctx.db
        .query('migration_events')
        .withIndex('by_migration_job', (q) => q.eq('migrationJobId', args.migrationJobId))
        .order('desc')
        .take(50),
    ]);

    return {
      job: {
        id: job._id,
        setupJobId: job.setupJobId,
        guildLinkId: job.guildLinkId,
        discordGuildId: job.discordGuildId,
        mode: job.mode,
        status: job.status,
        currentPhase: job.currentPhase,
        sourceBotKey: job.sourceBotKey,
        sourceGuildId: job.sourceGuildId,
        blockingReason: job.blockingReason,
        summary: job.summary,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        cancelledAt: job.cancelledAt,
        failedAt: job.failedAt,
      },
      sources: sources.map((source) => ({
        id: source._id,
        sourceKey: source.sourceKey,
        sourceType: source.sourceType,
        capabilityMode: source.capabilityMode,
        status: source.status,
        displayName: source.displayName,
        payload: source.payload,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
      })),
      roleMappings: roleMappings.map((mapping) => ({
        id: mapping._id,
        provider: mapping.provider,
        sourceRoleId: mapping.sourceRoleId,
        sourceRoleName: mapping.sourceRoleName,
        targetProductId: mapping.targetProductId,
        targetProductName: mapping.targetProductName,
        targetRoleId: mapping.targetRoleId,
        targetRoleName: mapping.targetRoleName,
        matchStrategy: mapping.matchStrategy,
        confidence: mapping.confidence,
        status: mapping.status,
        reviewNote: mapping.reviewNote,
        payload: mapping.payload,
        createdAt: mapping.createdAt,
        updatedAt: mapping.updatedAt,
      })),
      grants: grants.map((grant) => ({
        id: grant._id,
        discordUserId: grant.discordUserId,
        roleId: grant.roleId,
        roleName: grant.roleName,
        productId: grant.productId,
        status: grant.status,
        provenance: grant.provenance,
        expiresAt: grant.expiresAt,
        createdAt: grant.createdAt,
        updatedAt: grant.updatedAt,
        promotedAt: grant.promotedAt,
        revokedAt: grant.revokedAt,
      })),
      events: events.map((event) => ({
        id: event._id,
        phase: event.phase,
        level: event.level,
        eventType: event.eventType,
        message: event.message,
        payload: event.payload,
        createdAt: event.createdAt,
      })),
    };
  },
});

export const getMyLatestMigrationJobForGuild = query({
  args: {
    guildId: v.string(),
  },
  returns: v.union(v.null(), MigrationJobDetailV),
  handler: async (ctx, args) => {
    const authUser = await getAuthenticatedAuthUser(ctx);
    if (!authUser) {
      return null;
    }

    const guildLink = await ctx.db
      .query('guild_links')
      .withIndex('by_discord_guild', (q) => q.eq('discordGuildId', args.guildId))
      .first();
    if (!guildLink || guildLink.authUserId !== authUser.authUserId) {
      return null;
    }

    const job = await ctx.db
      .query('migration_jobs')
      .withIndex('by_guild_link', (q) => q.eq('guildLinkId', guildLink._id))
      .order('desc')
      .first();
    if (!job || job.authUserId !== authUser.authUserId) {
      return null;
    }

    const [sources, roleMappings, grants, events] = await Promise.all([
      ctx.db
        .query('migration_sources')
        .withIndex('by_migration_job', (q) => q.eq('migrationJobId', job._id))
        .order('asc')
        .collect(),
      ctx.db
        .query('migration_role_mappings')
        .withIndex('by_migration_job', (q) => q.eq('migrationJobId', job._id))
        .order('asc')
        .collect(),
      ctx.db
        .query('migration_grants')
        .withIndex('by_migration_job', (q) => q.eq('migrationJobId', job._id))
        .order('asc')
        .take(500),
      ctx.db
        .query('migration_events')
        .withIndex('by_migration_job', (q) => q.eq('migrationJobId', job._id))
        .order('desc')
        .take(50),
    ]);

    return {
      job: {
        id: job._id,
        setupJobId: job.setupJobId,
        guildLinkId: job.guildLinkId,
        discordGuildId: job.discordGuildId,
        mode: job.mode,
        status: job.status,
        currentPhase: job.currentPhase,
        sourceBotKey: job.sourceBotKey,
        sourceGuildId: job.sourceGuildId,
        blockingReason: job.blockingReason,
        summary: job.summary,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        cancelledAt: job.cancelledAt,
        failedAt: job.failedAt,
      },
      sources: sources.map((source) => ({
        id: source._id,
        sourceKey: source.sourceKey,
        sourceType: source.sourceType,
        capabilityMode: source.capabilityMode,
        status: source.status,
        displayName: source.displayName,
        payload: source.payload,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
      })),
      roleMappings: roleMappings.map((mapping) => ({
        id: mapping._id,
        provider: mapping.provider,
        sourceRoleId: mapping.sourceRoleId,
        sourceRoleName: mapping.sourceRoleName,
        targetProductId: mapping.targetProductId,
        targetProductName: mapping.targetProductName,
        targetRoleId: mapping.targetRoleId,
        targetRoleName: mapping.targetRoleName,
        matchStrategy: mapping.matchStrategy,
        confidence: mapping.confidence,
        status: mapping.status,
        reviewNote: mapping.reviewNote,
        payload: mapping.payload,
        createdAt: mapping.createdAt,
        updatedAt: mapping.updatedAt,
      })),
      grants: grants.map((grant) => ({
        id: grant._id,
        discordUserId: grant.discordUserId,
        roleId: grant.roleId,
        roleName: grant.roleName,
        productId: grant.productId,
        status: grant.status,
        provenance: grant.provenance,
        expiresAt: grant.expiresAt,
        createdAt: grant.createdAt,
        updatedAt: grant.updatedAt,
        promotedAt: grant.promotedAt,
        revokedAt: grant.revokedAt,
      })),
      events: events.map((event) => ({
        id: event._id,
        phase: event.phase,
        level: event.level,
        eventType: event.eventType,
        message: event.message,
        payload: event.payload,
        createdAt: event.createdAt,
      })),
    };
  },
});

export const upsertMigrationSource = mutation({
  args: {
    apiSecret: v.string(),
    migrationJobId: v.id('migration_jobs'),
    sourceKey: v.string(),
    sourceType: MigrationSourceType,
    capabilityMode: MigrationCapabilityMode,
    status: MigrationSourceStatus,
    displayName: v.optional(v.string()),
    payload: v.optional(v.any()),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const job = await ctx.db.get(args.migrationJobId);
    if (!job) {
      throw new ConvexError('Migration job not found');
    }

    const existing = await ctx.db
      .query('migration_sources')
      .withIndex('by_migration_job', (q) => q.eq('migrationJobId', args.migrationJobId))
      .collect();
    const match = existing.find((source) => source.sourceKey === args.sourceKey);
    const now = Date.now();

    if (match) {
      await ctx.db.patch(match._id, {
        sourceType: args.sourceType,
        capabilityMode: args.capabilityMode,
        status: args.status,
        displayName: args.displayName,
        payload: args.payload,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert('migration_sources', {
        migrationJobId: args.migrationJobId,
        authUserId: job.authUserId,
        guildLinkId: job.guildLinkId,
        sourceKey: args.sourceKey,
        sourceType: args.sourceType,
        capabilityMode: args.capabilityMode,
        status: args.status,
        displayName: args.displayName,
        payload: args.payload,
        createdAt: now,
        updatedAt: now,
      });
    }

    return { success: true };
  },
});

export const updateMigrationJobState = mutation({
  args: {
    apiSecret: v.string(),
    migrationJobId: v.id('migration_jobs'),
    status: v.optional(MigrationJobStatus),
    currentPhase: v.optional(MigrationPhase),
    blockingReason: v.optional(v.union(v.string(), v.null())),
    summary: v.optional(v.any()),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const job = await ctx.db.get(args.migrationJobId);
    if (!job) {
      throw new ConvexError('Migration job not found');
    }

    const now = Date.now();
    const patch: Record<string, unknown> = { updatedAt: now };
    if (args.status !== undefined) {
      patch.status = args.status;
      if (args.status === 'completed') patch.completedAt = now;
      if (args.status === 'failed') patch.failedAt = now;
      if (args.status === 'cancelled') patch.cancelledAt = now;
    }
    if (args.currentPhase !== undefined) patch.currentPhase = args.currentPhase;
    if (args.blockingReason !== undefined) patch.blockingReason = args.blockingReason ?? undefined;
    if (args.summary !== undefined) patch.summary = args.summary;

    await ctx.db.patch(args.migrationJobId, patch);
    await appendAuditEvent(ctx, {
      authUserId: job.authUserId,
      eventType: 'migration.job.status.updated',
      metadata: {
        migrationJobId: args.migrationJobId,
        status: args.status,
        currentPhase: args.currentPhase,
      },
    });
    return { success: true };
  },
});

export const upsertMigrationRoleMapping = mutation({
  args: {
    apiSecret: v.string(),
    migrationJobId: v.id('migration_jobs'),
    provider: v.optional(Provider),
    sourceRoleId: v.optional(v.string()),
    sourceRoleName: v.string(),
    targetProductId: v.optional(v.string()),
    targetProductName: v.optional(v.string()),
    targetRoleId: v.optional(v.string()),
    targetRoleName: v.optional(v.string()),
    matchStrategy: MigrationMatchStrategy,
    confidence: v.optional(v.number()),
    status: MigrationRoleMappingStatus,
    reviewNote: v.optional(v.string()),
    payload: v.optional(v.any()),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const job = await ctx.db.get(args.migrationJobId);
    if (!job) {
      throw new ConvexError('Migration job not found');
    }

    const existing = await ctx.db
      .query('migration_role_mappings')
      .withIndex('by_migration_job', (q) => q.eq('migrationJobId', args.migrationJobId))
      .collect();
    const match = existing.find(
      (mapping) =>
        mapping.sourceRoleId === args.sourceRoleId && mapping.sourceRoleName === args.sourceRoleName
    );
    const now = Date.now();

    if (match) {
      await ctx.db.patch(match._id, {
        provider: args.provider,
        targetProductId: args.targetProductId,
        targetProductName: args.targetProductName,
        targetRoleId: args.targetRoleId,
        targetRoleName: args.targetRoleName,
        matchStrategy: args.matchStrategy,
        confidence: args.confidence,
        status: args.status,
        reviewNote: args.reviewNote,
        payload: args.payload,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert('migration_role_mappings', {
        migrationJobId: args.migrationJobId,
        authUserId: job.authUserId,
        guildLinkId: job.guildLinkId,
        discordGuildId: job.discordGuildId,
        provider: args.provider,
        sourceRoleId: args.sourceRoleId,
        sourceRoleName: args.sourceRoleName,
        targetProductId: args.targetProductId,
        targetProductName: args.targetProductName,
        targetRoleId: args.targetRoleId,
        targetRoleName: args.targetRoleName,
        matchStrategy: args.matchStrategy,
        confidence: args.confidence,
        status: args.status,
        reviewNote: args.reviewNote,
        payload: args.payload,
        createdAt: now,
        updatedAt: now,
      });
    }

    return { success: true };
  },
});

export const upsertMigrationGrant = mutation({
  args: {
    apiSecret: v.string(),
    migrationJobId: v.id('migration_jobs'),
    discordUserId: v.string(),
    roleId: v.string(),
    roleName: v.optional(v.string()),
    productId: v.optional(v.string()),
    status: MigrationGrantStatus,
    provenance: v.optional(v.any()),
    expiresAt: v.optional(v.number()),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const job = await ctx.db.get(args.migrationJobId);
    if (!job) {
      throw new ConvexError('Migration job not found');
    }

    const existing = await ctx.db
      .query('migration_grants')
      .withIndex('by_migration_job', (q) => q.eq('migrationJobId', args.migrationJobId))
      .collect();
    const match = existing.find(
      (grant) => grant.discordUserId === args.discordUserId && grant.roleId === args.roleId
    );
    const now = Date.now();

    if (match) {
      await ctx.db.patch(match._id, {
        roleName: args.roleName,
        productId: args.productId,
        status: args.status,
        provenance: args.provenance,
        expiresAt: args.expiresAt,
        updatedAt: now,
        promotedAt:
          args.status === 'canonical' && match.status !== 'canonical' ? now : match.promotedAt,
        revokedAt: args.status === 'revoked' ? now : undefined,
      });
    } else {
      await ctx.db.insert('migration_grants', {
        migrationJobId: args.migrationJobId,
        authUserId: job.authUserId,
        guildLinkId: job.guildLinkId,
        discordGuildId: job.discordGuildId,
        discordUserId: args.discordUserId,
        roleId: args.roleId,
        roleName: args.roleName,
        productId: args.productId,
        status: args.status,
        provenance: args.provenance,
        expiresAt: args.expiresAt,
        createdAt: now,
        updatedAt: now,
        promotedAt: args.status === 'canonical' ? now : undefined,
        revokedAt: args.status === 'revoked' ? now : undefined,
      });
    }

    return { success: true };
  },
});

export const appendMigrationEvent = mutation({
  args: {
    apiSecret: v.string(),
    migrationJobId: v.id('migration_jobs'),
    phase: v.optional(MigrationPhase),
    level: EventLevel,
    eventType: v.string(),
    message: v.string(),
    payload: v.optional(v.any()),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const job = await ctx.db.get(args.migrationJobId);
    if (!job) {
      throw new ConvexError('Migration job not found');
    }

    await ctx.db.insert('migration_events', {
      migrationJobId: args.migrationJobId,
      authUserId: job.authUserId,
      guildLinkId: job.guildLinkId,
      discordGuildId: job.discordGuildId,
      phase: args.phase,
      level: args.level,
      eventType: args.eventType,
      message: args.message,
      payload: args.payload,
      createdAt: Date.now(),
    });
    return { success: true };
  },
});
