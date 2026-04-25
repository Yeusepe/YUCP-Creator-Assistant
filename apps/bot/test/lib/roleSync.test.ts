import { beforeEach, describe, expect, it, mock } from 'bun:test';

const queryMock = mock(async () => undefined);
const mutationMock = mock(async () => undefined);
const actionMock = mock(async () => undefined);
const sendDashboardNotificationMock = mock(() => undefined);

mock.module('convex/browser', () => ({
  ConvexHttpClient: class {
    query = queryMock;
    mutation = mutationMock;
    action = actionMock;
  },
}));

mock.module('@yucp/shared', () => ({
  createStructuredLogger: () => {
    const logger = {
      child: mock(() => logger),
      debug: mock(() => undefined),
      info: mock(() => undefined),
      warn: mock(() => undefined),
      error: mock(() => undefined),
    };
    return logger;
  },
}));

mock.module('../../src/lib/notifications', () => ({
  sendDashboardNotification: sendDashboardNotificationMock,
}));

mock.module('../../src/lib/observability', () => ({
  withBotSpan: async (_name: string, _attrs: unknown, fn: () => Promise<unknown>) => await fn(),
  withBotStageSpan: async (_name: string, _attrs: unknown, fn: () => Promise<unknown>) =>
    await fn(),
}));

mock.module('../../src/lib/roleHierarchy', () => ({
  canBotManageRole: () => ({ canManage: true }),
}));

mock.module('../../src/lib/internalRpc', () => ({
  listProviderProducts: mock(async () => ({ products: [] })),
}));

mock.module('../../../../convex/_generated/api', () => ({
  api: {
    guildLinks: {
      getVerifyPromptMessageForBot: 'guildLinks:getVerifyPromptMessageForBot',
      clearVerifyPromptMessage: 'guildLinks:clearVerifyPromptMessage',
    },
    role_rules: {
      getByGuildWithProductNames: 'role_rules:getByGuildWithProductNames',
      getEnabledVerificationProvidersFromProducts:
        'role_rules:getEnabledVerificationProvidersFromProducts',
      addProductForProvider: 'role_rules:addProductForProvider',
      createRoleRule: 'role_rules:createRoleRule',
      getByProduct: 'role_rules:getByProduct',
    },
    setupJobs: {
      upsertSetupRecommendation: 'setupJobs:upsertSetupRecommendation',
      advanceSetupToReviewExceptions: 'setupJobs:advanceSetupToReviewExceptions',
      getSetupRolePlanEntries: 'setupJobs:getSetupRolePlanEntries',
      upsertSetupStep: 'setupJobs:upsertSetupStep',
      appendSetupEvent: 'setupJobs:appendSetupEvent',
      updateSetupJobState: 'setupJobs:updateSetupJobState',
      upsertMigrationRoleMapping: 'setupJobs:upsertMigrationRoleMapping',
      upsertMigrationSource: 'setupJobs:upsertMigrationSource',
      appendMigrationEvent: 'setupJobs:appendMigrationEvent',
      updateMigrationJobState: 'setupJobs:updateMigrationJobState',
    },
    backgroundSync: {
      processRetroactiveRuleSyncJob: 'backgroundSync:processRetroactiveRuleSyncJob',
    },
    identitySync: {
      getOrCreateSubjectForDiscordUser: 'identitySync:getOrCreateSubjectForDiscordUser',
    },
    entitlements: {
      grantEntitlement: 'entitlements:grantEntitlement',
      getEntitlement: 'entitlements:getEntitlement',
    },
    catalogTiers: {
      getActiveCatalogTierIdsForEntitlement: 'catalogTiers:getActiveCatalogTierIdsForEntitlement',
    },
    audit_events: {
      createAuditEvent: 'audit_events:createAuditEvent',
    },
    outbox_jobs: {
      getPendingJobs: 'outbox_jobs:getPendingJobs',
      updateJobStatus: 'outbox_jobs:updateJobStatus',
    },
  },
}));

import type { Client } from 'discord.js';
import { type OutboxJob, RoleSyncService } from '../../src/services/roleSync';

function createService(discordClientOverrides?: Partial<Client>) {
  return new RoleSyncService({
    convexUrl: 'https://convex.example.test',
    apiSecret: 'test-secret',
    discordClient: {
      guilds: {
        fetch: mock(async () => {
          throw new Error('guild fetch should not run');
        }),
      },
      ...discordClientOverrides,
    } as unknown as Client,
    pollIntervalMs: 5_000,
  });
}

function createJob(overrides: { jobType: OutboxJob['jobType']; payload: unknown }): OutboxJob {
  return {
    _id: 'job-123' as never,
    authUserId: 'auth-user-123',
    jobType: overrides.jobType,
    payload: overrides.payload as OutboxJob['payload'],
    status: 'pending',
    retryCount: 0,
    maxRetries: 5,
  } as OutboxJob;
}

describe('role sync service regressions', () => {
  beforeEach(() => {
    queryMock.mockReset();
    mutationMock.mockReset();
    actionMock.mockReset();
    sendDashboardNotificationMock.mockReset();
  });

  it('dead-letters non-retriable role sync failures returned as job results', async () => {
    const service = createService();
    const updateJobStatusMock = mock(async () => undefined);
    const handleJobFailureMock = mock(async () => undefined);
    const processRoleSyncJobMock = mock(async () => ({
      success: false,
      guildId: 'guild-123',
      discordUserId: 'user-123',
      rolesAdded: [],
      rolesRemoved: [],
      error: 'Bot lacks permission to manage roles',
      nonRetriable: true,
    }));

    (service as unknown as { updateJobStatus: typeof updateJobStatusMock }).updateJobStatus =
      updateJobStatusMock;
    (service as unknown as { handleJobFailure: typeof handleJobFailureMock }).handleJobFailure =
      handleJobFailureMock;
    (
      service as unknown as { processRoleSyncJob: typeof processRoleSyncJobMock }
    ).processRoleSyncJob = processRoleSyncJobMock;

    await (
      service as unknown as {
        processJob: (job: OutboxJob) => Promise<void>;
      }
    ).processJob(
      createJob({
        jobType: 'role_sync',
        payload: {
          subjectId: 'subject-123' as never,
          entitlementId: 'entitlement-123' as never,
          discordUserId: 'user-123',
        },
      })
    );

    expect(updateJobStatusMock.mock.calls as unknown as Array<unknown[]>).toEqual([
      ['job-123', 'in_progress'],
      ['job-123', 'dead_letter', 'Bot lacks permission to manage roles'],
    ]);
    expect(handleJobFailureMock).not.toHaveBeenCalled();
  });

  it('dead-letters non-retriable role removal failures returned as job results', async () => {
    const service = createService();
    const updateJobStatusMock = mock(async () => undefined);
    const handleJobFailureMock = mock(async () => undefined);
    const processRoleRemovalJobMock = mock(async () => ({
      success: false,
      guildId: 'guild-123',
      discordUserId: 'user-123',
      rolesAdded: [],
      rolesRemoved: [],
      error: 'Bot lacks permission to manage roles',
      nonRetriable: true,
    }));

    (service as unknown as { updateJobStatus: typeof updateJobStatusMock }).updateJobStatus =
      updateJobStatusMock;
    (service as unknown as { handleJobFailure: typeof handleJobFailureMock }).handleJobFailure =
      handleJobFailureMock;
    (
      service as unknown as { processRoleRemovalJob: typeof processRoleRemovalJobMock }
    ).processRoleRemovalJob = processRoleRemovalJobMock;

    await (
      service as unknown as {
        processJob: (job: OutboxJob) => Promise<void>;
      }
    ).processJob(
      createJob({
        jobType: 'role_removal',
        payload: {
          subjectId: 'subject-123' as never,
          entitlementId: 'entitlement-123' as never,
          guildId: 'guild-123',
          roleId: 'role-123',
          discordUserId: 'user-123',
        },
      })
    );

    expect(updateJobStatusMock.mock.calls as unknown as Array<unknown[]>).toEqual([
      ['job-123', 'in_progress'],
      ['job-123', 'dead_letter', 'Bot lacks permission to manage roles'],
    ]);
    expect(handleJobFailureMock).not.toHaveBeenCalled();
  });

  it('skips setup plan generation when the guild link has been disconnected', async () => {
    const fetchGuildMock = mock(async () => {
      throw new Error('guild fetch should not run');
    });
    const service = createService({
      guilds: {
        fetch: fetchGuildMock,
      } as never,
    });

    (queryMock as unknown as { mockResolvedValue(value: unknown): void }).mockResolvedValue(null);

    await (
      service as unknown as {
        processSetupGeneratePlanJob: (job: OutboxJob) => Promise<void>;
      }
    ).processSetupGeneratePlanJob(
      createJob({
        jobType: 'setup_generate_plan',
        payload: {
          setupJobId: 'setup-job-123' as never,
          guildLinkId: 'guild-link-123' as never,
          guildId: 'guild-123',
        },
      })
    );

    expect(fetchGuildMock).not.toHaveBeenCalled();
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it('treats legacy rules without a provider as existing setup matches', () => {
    const service = createService();

    const matched = (
      service as unknown as {
        matchesExistingGuildRule: (
          rules: Array<{
            productId: string;
            displayName: string | null;
            provider?: string;
            enabled?: boolean;
          }>,
          product: { id: string; name: string; provider: 'gumroad' }
        ) => boolean;
      }
    ).matchesExistingGuildRule(
      [
        {
          productId: 'legacy-product-1',
          displayName: 'Supporter',
          enabled: true,
        },
      ],
      {
        id: 'new-product-1',
        name: 'Supporter',
        provider: 'gumroad',
      }
    );

    expect(matched).toBe(true);
  });

  it('retries role sync jobs when active tier lookup fails instead of collapsing to product-wide rules', async () => {
    const service = createService();
    const processRoleSyncJob = (
      service as unknown as {
        processRoleSyncJob: (job: OutboxJob) => Promise<unknown>;
      }
    ).processRoleSyncJob.bind(service);

    (
      service as unknown as {
        fetchEntitlement: (entitlementId: string) => Promise<{
          _id: string;
          productId: string;
          status: 'active';
        }>;
      }
    ).fetchEntitlement = mock(
      async (): Promise<{
        _id: string;
        productId: string;
        status: 'active';
      }> => ({
        _id: 'entitlement-123',
        productId: 'product-tiered',
        status: 'active',
      })
    );
    (
      service as unknown as {
        fetchRoleRules: (
          authUserId: string,
          productId: string
        ) => Promise<
          Array<{
            catalogTierId?: string;
            enabled: boolean;
            guildId: string;
            verifiedRoleId?: string;
            verifiedRoleIds?: string[];
          }>
        >;
      }
    ).fetchRoleRules = mock(async () => [
      {
        catalogTierId: 'catalog-tier-1',
        enabled: true,
        guildId: 'guild-123',
        verifiedRoleId: 'role-123',
      },
    ]);
    (queryMock as unknown as { mockRejectedValueOnce(value: unknown): void }).mockRejectedValueOnce(
      new Error('catalog tiers unavailable')
    );

    await expect(
      processRoleSyncJob(
        createJob({
          jobType: 'role_sync',
          payload: {
            subjectId: 'subject-123' as never,
            entitlementId: 'entitlement-123' as never,
            discordUserId: 'user-123',
          },
        })
      )
    ).rejects.toThrow('catalog tiers unavailable');
  });

  it('skips already-applied plan entries instead of replaying create role rule work', async () => {
    const roleCreateMock = mock(async () => ({ id: 'role-created-1' }));
    const service = createService({
      guilds: {
        fetch: mock(async () => ({
          id: 'guild-123',
          features: [],
          mfaLevel: 0,
          roles: {
            fetch: mock(async () => undefined),
            create: roleCreateMock,
            cache: new Map<string, unknown>(),
          },
          channels: {
            fetch: mock(async () => undefined),
          },
          members: {
            fetchMe: mock(async () => undefined),
            me: {
              roles: {
                highest: { name: 'YUCP', position: 10 },
              },
            },
          },
        })),
      } as never,
    });

    const queryMockWithValues = queryMock as unknown as {
      mockResolvedValueOnce(value: unknown): typeof queryMockWithValues;
    };
    queryMockWithValues
      .mockResolvedValueOnce({ channelId: 'verify-channel', messageId: 'verify-message' })
      .mockResolvedValueOnce([
        {
          productId: 'prod-1',
          displayName: 'Supporter',
          provider: 'gumroad',
          enabled: true,
        },
      ])
      .mockResolvedValueOnce([
        {
          _id: 'rec-1',
          title: 'Supporter (gumroad)',
          detail: 'Create a new role named "Supporter".',
          payload: {
            productId: 'prod-1',
            productName: 'Supporter',
            provider: 'gumroad',
            action: 'create_role',
            proposedRoleName: 'Supporter',
          },
        },
      ]);

    await (
      service as unknown as {
        processSetupApplyJob: (job: OutboxJob) => Promise<void>;
      }
    ).processSetupApplyJob(
      createJob({
        jobType: 'setup_apply',
        payload: {
          setupJobId: 'setup-job-123' as never,
          guildLinkId: 'guild-link-123' as never,
          guildId: 'guild-123',
          skipVerifyPrompt: true,
          verificationMessageMode: 'leave_unchanged',
        },
      })
    );

    expect(roleCreateMock).not.toHaveBeenCalled();
    expect(
      (mutationMock.mock.calls as unknown as Array<[unknown, Record<string, unknown>]>).some(
        ([, args]) => Boolean(args && typeof args === 'object' && 'providerProductRef' in args)
      )
    ).toBe(false);
    expect(
      (mutationMock.mock.calls as unknown as Array<[unknown, Record<string, unknown>]>).some(
        ([, args]) => Boolean(args && typeof args === 'object' && 'verifiedRoleId' in args)
      )
    ).toBe(false);
  });

  it('reuses a previously created role id on setup-apply retry instead of creating another role', async () => {
    const roleCreateMock = mock(async () => ({ id: 'role-created-2' }));
    const service = createService({
      guilds: {
        fetch: mock(async () => ({
          id: 'guild-123',
          features: [],
          mfaLevel: 0,
          roles: {
            fetch: mock(async () => undefined),
            create: roleCreateMock,
            cache: new Map<
              string,
              { id: string; name: string; managed: boolean; position: number }
            >([
              [
                'role-created-1',
                {
                  id: 'role-created-1',
                  name: 'Supporter',
                  managed: false,
                  position: 1,
                },
              ],
            ]),
          },
          channels: {
            fetch: mock(async () => undefined),
          },
          members: {
            fetchMe: mock(async () => undefined),
            me: {
              roles: {
                highest: { name: 'YUCP', position: 10 },
              },
            },
          },
        })),
      } as never,
    });

    let mutationInvocation = 0;
    (
      mutationMock as unknown as {
        mockImplementation(fn: () => Promise<unknown>): void;
      }
    ).mockImplementation(async () => {
      mutationInvocation += 1;
      if (mutationInvocation === 1) {
        return {
          productId: 'prod-1',
          catalogProductId: 'catalog-1',
        };
      }
      if (mutationInvocation === 2) {
        return {
          ruleId: 'rule-1',
        };
      }
      return undefined;
    });
    const queryRetryMock = queryMock as unknown as {
      mockResolvedValueOnce(value: unknown): typeof queryRetryMock;
    };
    queryRetryMock
      .mockResolvedValueOnce({ channelId: 'verify-channel', messageId: 'verify-message' })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          _id: 'rec-1',
          title: 'Supporter (gumroad)',
          detail: 'Create a new role named "Supporter".',
          payload: {
            productId: 'prod-1',
            productName: 'Supporter',
            provider: 'gumroad',
            action: 'create_role',
            proposedRoleName: 'Supporter',
            appliedRoleId: 'role-created-1',
          },
        },
      ]);

    await (
      service as unknown as {
        processSetupApplyJob: (job: OutboxJob) => Promise<void>;
      }
    ).processSetupApplyJob(
      createJob({
        jobType: 'setup_apply',
        payload: {
          setupJobId: 'setup-job-123' as never,
          guildLinkId: 'guild-link-123' as never,
          guildId: 'guild-123',
          skipVerifyPrompt: true,
          verificationMessageMode: 'leave_unchanged',
        },
      })
    );

    expect(roleCreateMock).not.toHaveBeenCalled();
    expect(
      (mutationMock.mock.calls as unknown as Array<[unknown, Record<string, unknown>]>)[1]?.[1]
    ).toMatchObject({
      verifiedRoleId: 'role-created-1',
    });
  });
});
