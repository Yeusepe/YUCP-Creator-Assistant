import { beforeEach, describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { makeTestConvex } from './testHelpers';

const API_SECRET = 'test-secret';

async function seedGuildLink(
  t: ReturnType<typeof makeTestConvex>,
  args: {
    authUserId: string;
    discordGuildId?: string;
  }
): Promise<Id<'guild_links'>> {
  return t.run(async (ctx) => {
    const now = Date.now();
    return ctx.db.insert('guild_links', {
      authUserId: args.authUserId,
      discordGuildId: args.discordGuildId ?? `guild-${now}`,
      installedByAuthUserId: args.authUserId,
      botPresent: true,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function seedProviderConnection(
  t: ReturnType<typeof makeTestConvex>,
  args: {
    authUserId: string;
    provider?: 'gumroad' | 'itchio' | 'jinxxy' | 'lemonsqueezy' | 'payhip' | 'vrchat';
  }
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert('provider_connections', {
      authUserId: args.authUserId,
      provider: args.provider ?? 'gumroad',
      providerKey: args.provider ?? 'gumroad',
      connectionType: 'setup',
      status: 'active',
      webhookConfigured: false,
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe('setup jobs orchestration', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = API_SECRET;
  });

  it('creates a durable automatic setup job with the doc-aligned default steps', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-setup-create';
    const guildLinkId = await seedGuildLink(t, {
      authUserId,
      discordGuildId: 'guild-setup-create',
    });

    const result = await t.mutation(api.setupJobs.createOrResumeSetupJobForOwner, {
      apiSecret: API_SECRET,
      authUserId,
      guildLinkId,
      mode: 'automatic_setup',
      triggerSource: 'discord_autosetup',
    });

    expect(result.created).toBe(true);

    const { job, steps, recommendations, auditEvents } = await t.run(async (ctx) => {
      const job = await ctx.db.get(result.setupJobId);
      const steps = await ctx.db
        .query('setup_job_steps')
        .withIndex('by_setup_job', (q) => q.eq('setupJobId', result.setupJobId))
        .order('asc')
        .collect();
      const recommendations = await ctx.db
        .query('setup_recommendations')
        .withIndex('by_setup_job', (q) => q.eq('setupJobId', result.setupJobId))
        .collect();
      const auditEvents = await ctx.db
        .query('audit_events')
        .withIndex('by_auth_user_event', (q) =>
          q.eq('authUserId', authUserId).eq('eventType', 'setup.job.created')
        )
        .collect();
      return { job, steps, recommendations, auditEvents };
    });

    expect(job).toMatchObject({
      authUserId,
      guildLinkId,
      discordGuildId: 'guild-setup-create',
      mode: 'automatic_setup',
      triggerSource: 'discord_autosetup',
      status: 'waiting_for_user',
      currentPhase: 'connect_store',
      activeStepKey: 'connect-store',
    });
    expect(steps.map((step) => step.stepKey)).toEqual([
      'connect-store',
      'scan-server',
      'generate-plan',
      'review-exceptions',
      'apply-setup',
      'shadow-migration',
      'confirm-cutover',
    ]);
    expect(steps[0]?.status).toBe('waiting_for_user');
    expect(steps.slice(1).every((step) => step.status === 'pending')).toBe(true);
    expect(recommendations).toHaveLength(3);
    expect(recommendations.map((recommendation) => recommendation.recommendationType)).toEqual([
      'provider_connection',
      'role_creation',
      'verify_surface_creation',
    ]);
    expect(auditEvents).toHaveLength(1);
  });

  it('resumes an active setup job instead of creating a duplicate', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-setup-resume';
    const guildLinkId = await seedGuildLink(t, {
      authUserId,
      discordGuildId: 'guild-setup-resume',
    });

    const first = await t.mutation(api.setupJobs.createOrResumeSetupJobForOwner, {
      apiSecret: API_SECRET,
      authUserId,
      guildLinkId,
      mode: 'automatic_setup',
      triggerSource: 'dashboard',
    });
    const second = await t.mutation(api.setupJobs.createOrResumeSetupJobForOwner, {
      apiSecret: API_SECRET,
      authUserId,
      guildLinkId,
      mode: 'automatic_setup',
      triggerSource: 'discord_setup',
    });

    expect(first.created).toBe(true);
    expect(second).toEqual({
      setupJobId: first.setupJobId,
      created: false,
    });

    const { jobs, resumeEvents } = await t.run(async (ctx) => {
      const jobs = await ctx.db
        .query('setup_jobs')
        .withIndex('by_guild_link', (q) => q.eq('guildLinkId', guildLinkId))
        .collect();
      const resumeEvents = await ctx.db
        .query('audit_events')
        .withIndex('by_auth_user_event', (q) =>
          q.eq('authUserId', authUserId).eq('eventType', 'setup.job.resumed')
        )
        .collect();
      return { jobs, resumeEvents };
    });

    expect(jobs).toHaveLength(1);
    expect(resumeEvents).toHaveLength(1);
  });

  it('creates a linked migration job for the same guild and setup job', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-migration-create';
    const guildLinkId = await seedGuildLink(t, {
      authUserId,
      discordGuildId: 'guild-migration-create',
    });

    const { setupJobId } = await t.mutation(api.setupJobs.createOrResumeSetupJobForOwner, {
      apiSecret: API_SECRET,
      authUserId,
      guildLinkId,
      mode: 'automatic_setup',
      triggerSource: 'dashboard',
    });

    const result = await t.mutation(api.setupJobs.createMigrationJobForOwner, {
      apiSecret: API_SECRET,
      authUserId,
      guildLinkId,
      setupJobId,
      mode: 'adopt_existing_roles',
      sourceBotKey: 'legacy-bot',
    });

    const { migrationJob, sources } = await t.run(async (ctx) => {
      const migrationJob = await ctx.db.get(result.migrationJobId);
      const sources = await ctx.db
        .query('migration_sources')
        .withIndex('by_migration_job', (q) => q.eq('migrationJobId', result.migrationJobId))
        .collect();
      return { migrationJob, sources };
    });
    expect(migrationJob).toMatchObject({
      authUserId,
      guildLinkId,
      setupJobId,
      discordGuildId: 'guild-migration-create',
      mode: 'adopt_existing_roles',
      status: 'running',
      currentPhase: 'analyze',
      sourceBotKey: 'legacy-bot',
    });
    expect(sources.map((source) => source.sourceKey)).toEqual(
      expect.arrayContaining(['existing-discord-state', 'manual-review-fallback', 'legacy-bot'])
    );
  });

  it('loads and resumes a setup job through the guild-scoped entrypoints', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-setup-guild-scope';
    await seedGuildLink(t, {
      authUserId,
      discordGuildId: 'guild-setup-guild-scope',
    });

    const created = await t.mutation(api.setupJobs.createOrResumeSetupJobForOwnerByGuild, {
      apiSecret: API_SECRET,
      authUserId,
      guildId: 'guild-setup-guild-scope',
      mode: 'automatic_setup',
      triggerSource: 'dashboard',
    });

    const detail = await t.query(api.setupJobs.getSetupJobForOwnerByGuild, {
      apiSecret: API_SECRET,
      authUserId,
      guildId: 'guild-setup-guild-scope',
    });

    expect(detail?.job.id).toBe(created.setupJobId);
    expect(detail?.job.discordGuildId).toBe('guild-setup-guild-scope');
    expect(detail?.steps).toHaveLength(7);
  });

  it('queues setup apply work after recommendations are ready', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-setup-apply';
    await seedProviderConnection(t, { authUserId, provider: 'gumroad' });
    await seedGuildLink(t, {
      authUserId,
      discordGuildId: 'guild-setup-apply',
    });

    const { setupJobId } = await t.mutation(api.setupJobs.createOrResumeSetupJobForOwnerByGuild, {
      apiSecret: API_SECRET,
      authUserId,
      guildId: 'guild-setup-apply',
      mode: 'automatic_setup',
      triggerSource: 'dashboard',
    });

    const result = await t.mutation(api.setupJobs.applyRecommendedSetupForOwnerByGuild, {
      apiSecret: API_SECRET,
      authUserId,
      guildId: 'guild-setup-apply',
    });

    expect(result).toEqual({ setupJobId, queued: true });

    const { job, applyStep, outboxJob } = await t.run(async (ctx) => {
      const job = await ctx.db.get(setupJobId);
      const applyStep = await ctx.db
        .query('setup_job_steps')
        .withIndex('by_setup_job_step', (q) =>
          q.eq('setupJobId', setupJobId).eq('stepKey', 'apply-setup')
        )
        .first();
      const outboxJob = await ctx.db
        .query('outbox_jobs')
        .withIndex('by_idempotency', (q) => q.eq('idempotencyKey', `setup_apply:${setupJobId}`))
        .first();
      return { job, applyStep, outboxJob };
    });

    expect(job).toMatchObject({
      status: 'running',
      currentPhase: 'apply_setup',
      activeStepKey: 'apply-setup',
    });
    expect(applyStep?.status).toBe('in_progress');
    expect(outboxJob?.jobType).toBe('setup_apply');
    expect(outboxJob?.status).toBe('pending');
  });
});
