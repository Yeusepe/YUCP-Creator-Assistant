import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { cwd } from 'node:process';
import { DiscordBotE2EHarness, safeCleanup } from './support';

let harness: DiscordBotE2EHarness;

describe('discord bot real-infrastructure e2e', () => {
  beforeAll(async () => {
    harness = await DiscordBotE2EHarness.start();
  });

  afterAll(async () => {
    if (harness) {
      await harness.stop();
    }
  });

  it('boots API and bot from source and registers slash commands in the target guild', async () => {
    const commands = await harness.fetchGuildCommands(harness.secrets.targetGuildId);
    const creator = commands.find((command) => command.name === 'creator');
    const creatorAdmin = commands.find((command) => command.name === 'creator-admin');

    expect(creator).toBeDefined();
    expect(creatorAdmin).toBeDefined();
    expect(creator?.options?.some((option) => option.name === 'status')).toBe(true);
    expect(creator?.options?.some((option) => option.name === 'refresh')).toBe(true);
    expect(creatorAdmin?.options?.some((option) => option.name === 'setup')).toBe(true);
    expect(creatorAdmin?.options?.some((option) => option.name === 'downloads')).toBe(true);
  });

  it('executes real admin slash commands through Discord Web with a logged-in admin user', async () => {
    const scenario = 'admin-flows';
    const channelId = await harness.createScenarioChannel(scenario, 'admin');
    const admin = await harness.openAdminSession();

    try {
      const page = await admin.openChannel(harness.secrets.targetGuildId, channelId);
      await admin.runSlashCommand(page, '/creator-admin stats', 'Verification Stats');
      await admin.runSlashCommand(page, '/creator-admin analytics', 'Analytics');
      await admin.runSlashCommand(page, '/creator-admin setup start', 'Creator Setup');
      await admin.waitForText(page, 'Open Setup Dashboard');
      await admin.close();
    } finally {
      await safeCleanup(harness, scenario, async () => {
        await admin.close().catch(() => {});
        await harness.cleanupScenario(scenario);
      });
    }
  });

  it('shows the real member status panel, docs link, and public verify entrypoint', async () => {
    const scenario = 'member-panels';
    const channelId = await harness.createScenarioChannel(scenario, 'verify');
    const admin = await harness.openAdminSession();
    const member = await harness.openMemberSession();

    try {
      const memberPage = await member.openChannel(harness.secrets.targetGuildId, channelId);
      await harness.ensureSubjectForDiscord(
        harness.secrets.memberUserId,
        `bot-e2e-member-${harness.runId}`
      );

      await member.runSlashCommand(memberPage, '/creator status');
      await member.waitForAnyText(memberPage, [
        'Your verification status',
        'You’re verified!',
        "You're verified!",
      ]);
      await member.waitForText(memberPage, 'Connected Accounts');
      await member.waitForText(memberPage, 'Verified Products');

      await member.runSlashCommand(memberPage, '/creator docs', 'Creator Assistant Documentation');

      const adminPage = await admin.openChannel(harness.secrets.targetGuildId, channelId);
      await admin.runSlashCommand(
        adminPage,
        '/creator-admin spawn-verify',
        'Verify message posted'
      );
      await member.waitForText(memberPage, 'Verify');
      await member.clickButton(memberPage, 'Verify');
      await member.waitForAnyText(memberPage, [
        'Your verification status',
        'You’re verified!',
        "You're verified!",
      ]);

      await admin.close();
      await member.close();
    } finally {
      await safeCleanup(harness, scenario, async () => {
        await admin.close().catch(() => {});
        await member.close().catch(() => {});
        await harness.cleanupScenario(scenario);
      });
    }
  });

  it('toggles cross-server verification from the real admin panel', async () => {
    const scenario = 'cross-server-settings';
    const channelId = await harness.createScenarioChannel(scenario, 'settings');
    const admin = await harness.openAdminSession();
    const originalTenant = await harness.getTenant();
    const originalPolicy = originalTenant?.policy ?? {};
    const originalEnabled = originalPolicy.enableDiscordRoleFromOtherServers === true;
    const originalAllowed = Array.isArray(originalPolicy.allowedSourceGuildIds)
      ? [...(originalPolicy.allowedSourceGuildIds as string[])]
      : [];

    try {
      const page = await admin.openChannel(harness.secrets.targetGuildId, channelId);

      await admin.runSlashCommand(
        page,
        '/creator-admin settings cross-server',
        'Cross-Server Role Verification'
      );
      await admin.waitForText(page, 'Allowed Source Servers');

      if (originalEnabled) {
        await admin.clickButton(page, 'Disable', 'Cross-server role verification has been');
        const disabledTenant = await harness.getTenant();
        expect(disabledTenant?.policy?.enableDiscordRoleFromOtherServers).toBe(false);

        await admin.clickButton(page, 'Enable', 'Cross-server role verification has been');
        const enabledTenant = await harness.getTenant();
        expect(enabledTenant?.policy?.enableDiscordRoleFromOtherServers).toBe(true);
      } else {
        await admin.clickButton(page, 'Enable', 'Cross-server role verification has been');
        const enabledTenant = await harness.getTenant();
        expect(enabledTenant?.policy?.enableDiscordRoleFromOtherServers).toBe(true);

        await admin.clickButton(page, 'Disable', 'Cross-server role verification has been');
        const disabledTenant = await harness.getTenant();
        expect(disabledTenant?.policy?.enableDiscordRoleFromOtherServers).toBe(false);
      }

      await admin.close();
    } finally {
      await safeCleanup(harness, scenario, async () => {
        await harness.updateTenantPolicy({
          enableDiscordRoleFromOtherServers: originalEnabled,
          allowedSourceGuildIds: originalAllowed,
        });
        await admin.close().catch(() => {});
        await harness.cleanupScenario(scenario);
      });
    }
  });

  it('queues role sync jobs with /creator refresh and applies real Discord roles', async () => {
    const scenario = 'refresh-role-sync';
    const interactionChannelId = await harness.createScenarioChannel(scenario, 'refresh');
    const verifiedRoleId = await harness.createScenarioRole(scenario, 'verified');
    const productId = `${harness.runId}:${scenario}:manual-product`;
    const subjectId = await harness.ensureSubjectForDiscord(
      harness.secrets.memberUserId,
      `bot-e2e-member-${harness.runId}`
    );
    await harness.recordResource({
      scenario,
      type: 'subject',
      id: subjectId,
    });
    await harness.recordResource({
      scenario,
      type: 'product',
      id: productId,
      metadata: {
        discordUserId: harness.secrets.memberUserId,
      },
    });
    const ruleId = await harness.createRoleRule({
      productId,
      verifiedRoleId,
    });
    await harness.recordResource({
      scenario,
      type: 'role_rule',
      id: ruleId,
    });

    const member = await harness.openMemberSession();

    try {
      await harness
        .removeRoleFromMember(
          harness.secrets.targetGuildId,
          harness.secrets.memberUserId,
          verifiedRoleId
        )
        .catch(() => {});
      await harness.grantManualEntitlement(
        subjectId,
        productId,
        `${harness.runId}:${scenario}:grant`
      );

      const page = await member.openChannel(harness.secrets.targetGuildId, interactionChannelId);
      await member.runSlashCommand(page, '/creator refresh', 'Queued 1 role sync jobs');
      await harness.waitForMemberRole(
        harness.secrets.targetGuildId,
        harness.secrets.memberUserId,
        verifiedRoleId
      );

      const refreshedMember = await harness.fetchMember(
        harness.secrets.targetGuildId,
        harness.secrets.memberUserId
      );
      expect(refreshedMember.roles.includes(verifiedRoleId)).toBe(true);

      await harness.revokeProductEntitlements(harness.secrets.memberUserId, productId);
      await harness.waitForMemberRoleRemoval(
        harness.secrets.targetGuildId,
        harness.secrets.memberUserId,
        verifiedRoleId
      );
      await member.close();
    } finally {
      await safeCleanup(harness, scenario, async () => {
        await member.close().catch(() => {});
        await harness.cleanupScenario(scenario);
      });
    }
  });

  it('syncs a target-guild role from a real source-guild role with cross-server policy enabled', async () => {
    const scenario = 'cross-server-refresh';
    const interactionChannelId = await harness.createScenarioChannel(scenario, 'refresh');
    const sourceRoleName = `${harness.runId}-${scenario}-source`.slice(0, 90);
    const targetRoleName = `${harness.runId}-${scenario}-verified`.slice(0, 90);
    const sourceRoleId = await harness.createRole(harness.secrets.sourceGuildId, sourceRoleName);
    await harness.recordResource({
      scenario,
      type: 'role',
      id: sourceRoleId,
      guildId: harness.secrets.sourceGuildId,
    });
    const targetRoleId = await harness.createRole(harness.secrets.targetGuildId, targetRoleName);
    await harness.recordResource({
      scenario,
      type: 'role',
      id: targetRoleId,
      guildId: harness.secrets.targetGuildId,
    });

    const originalTenant = await harness.getTenant();
    const originalPolicy = originalTenant?.policy ?? {};
    const originalEnabled = originalPolicy.enableDiscordRoleFromOtherServers === true;
    const originalAllowed = Array.isArray(originalPolicy.allowedSourceGuildIds)
      ? [...(originalPolicy.allowedSourceGuildIds as string[])]
      : [];

    const addedRule = await harness.addDiscordRoleProductRule({
      sourceGuildId: harness.secrets.sourceGuildId,
      requiredRoleIds: [sourceRoleId],
      verifiedRoleIds: [targetRoleId],
    });
    await harness.recordResource({
      scenario,
      type: 'role_rule',
      id: addedRule.ruleId,
    });

    const member = await harness.openMemberSession();
    const admin = await harness.openAdminSession();

    try {
      await harness.updateTenantPolicy({
        enableDiscordRoleFromOtherServers: true,
        allowedSourceGuildIds: [harness.secrets.sourceGuildId],
      });

      await harness.ensureSubjectForDiscord(
        harness.secrets.memberUserId,
        `bot-e2e-member-${harness.runId}`
      );
      await harness.addRoleToMember(
        harness.secrets.sourceGuildId,
        harness.secrets.memberUserId,
        sourceRoleId
      );

      const adminPage = await admin.openChannel(
        harness.secrets.targetGuildId,
        interactionChannelId
      );
      await admin.runSlashCommand(
        adminPage,
        '/creator-admin product list',
        'Product-Role Mappings'
      );
      await admin.waitForText(adminPage, targetRoleName);

      const page = await member.openChannel(harness.secrets.targetGuildId, interactionChannelId);
      await member.runSlashCommand(page, '/creator refresh', 'Queued');
      await harness.waitForMemberRole(
        harness.secrets.targetGuildId,
        harness.secrets.memberUserId,
        targetRoleId
      );

      await harness.removeRoleFromMember(
        harness.secrets.sourceGuildId,
        harness.secrets.memberUserId,
        sourceRoleId
      );
      await member.runSlashCommand(page, '/creator refresh', 'Queued');
      await harness.waitForMemberRoleRemoval(
        harness.secrets.targetGuildId,
        harness.secrets.memberUserId,
        targetRoleId
      );

      await admin.close();
      await member.close();
    } finally {
      await safeCleanup(harness, scenario, async () => {
        await harness.updateTenantPolicy({
          enableDiscordRoleFromOtherServers: originalEnabled,
          allowedSourceGuildIds: originalAllowed,
        });
        await harness
          .removeRoleFromMember(
            harness.secrets.sourceGuildId,
            harness.secrets.memberUserId,
            sourceRoleId
          )
          .catch(() => {});
        await admin.close().catch(() => {});
        await member.close().catch(() => {});
        await harness.cleanupScenario(scenario);
      });
    }
  });

  it('captures a real upload and enforces access through the download button', async () => {
    const scenario = 'liened-downloads';
    const sourceChannelId = await harness.createScenarioChannel(scenario, 'uploads');
    const archiveChannelId = await harness.createScenarioChannel(scenario, 'archive');
    const accessRoleId = await harness.createScenarioRole(scenario, 'downloaders');
    const routeId = await harness.createDownloadRoute({
      sourceChannelId,
      archiveChannelId,
      requiredRoleIds: [accessRoleId],
      roleLogic: 'any',
      allowedExtensions: ['txt'],
      messageTitle: 'Liened Download',
      messageBody: 'Only entitled members can download this file.',
    });
    await harness.recordResource({
      scenario,
      type: 'download_route',
      id: routeId,
    });

    const member = await harness.openMemberSession();
    const admin = await harness.openAdminSession();
    const fixturePath = join(
      cwd(),
      'apps',
      'bot',
      'test',
      'e2e',
      'fixtures',
      'sample-download.txt'
    );

    try {
      await harness.addRoleToMember(
        harness.secrets.targetGuildId,
        harness.secrets.memberUserId,
        accessRoleId
      );

      const memberPage = await member.openChannel(harness.secrets.targetGuildId, sourceChannelId);
      await member.uploadFile(memberPage, fixturePath);
      const artifacts = await harness.waitForDownloadArtifact(routeId);
      expect(artifacts.length).toBeGreaterThan(0);

      const adminPage = await admin.openChannel(harness.secrets.targetGuildId, sourceChannelId);
      await admin.clickButton(adminPage, 'Download', 'You don’t have access to this download yet.');

      await member.clickButton(memberPage, 'Download', 'Download Ready');

      const archiveMessages = await harness.fetchChannelMessages(archiveChannelId, 10);
      expect(archiveMessages.length).toBeGreaterThan(0);

      await admin.close();
      await member.close();
    } finally {
      await safeCleanup(harness, scenario, async () => {
        await admin.close().catch(() => {});
        await member.close().catch(() => {});
        await harness
          .removeRoleFromMember(
            harness.secrets.targetGuildId,
            harness.secrets.memberUserId,
            accessRoleId
          )
          .catch(() => {});
        await harness.cleanupScenario(scenario);
      });
    }
  });

  it('manages a live download route through the admin panel', async () => {
    const scenario = 'downloads-manage';
    const sourceChannelId = await harness.createScenarioChannel(scenario, 'uploads');
    const archiveChannelId = await harness.createScenarioChannel(scenario, 'archive');
    const accessRoleId = await harness.createScenarioRole(scenario, 'downloaders');
    const routeId = await harness.createDownloadRoute({
      sourceChannelId,
      archiveChannelId,
      requiredRoleIds: [accessRoleId],
      roleLogic: 'any',
      allowedExtensions: ['txt'],
      messageTitle: 'Managed Download',
      messageBody: 'The admin panel should be able to toggle this route.',
    });
    await harness.recordResource({
      scenario,
      type: 'download_route',
      id: routeId,
    });

    const admin = await harness.openAdminSession();

    try {
      const page = await admin.openChannel(harness.secrets.targetGuildId, sourceChannelId);
      await admin.runSlashCommand(
        page,
        '/creator-admin downloads manage',
        'Manage Liened Downloads'
      );
      await admin.waitForText(page, 'Route On');

      await admin.clickButton(page, 'Turn Off', 'Route is now');
      await admin.waitForText(page, 'Route Off');
      expect((await harness.getDownloadRoute(routeId))?.enabled).toBe(false);

      await admin.clickButton(page, 'Turn On', 'Route is now');
      await admin.waitForText(page, 'Route On');
      expect((await harness.getDownloadRoute(routeId))?.enabled).toBe(true);

      await admin.clickButton(page, 'Remove Route...', 'Remove this route?');
      await admin.clickButton(page, 'Remove Route', 'Route removed');
      expect(await harness.getDownloadRoute(routeId)).toBeNull();

      await admin.close();
    } finally {
      await safeCleanup(harness, scenario, async () => {
        await admin.close().catch(() => {});
        await harness.cleanupScenario(scenario);
      });
    }
  });

  it('lists and removes a real collaborator connection and generates a live invite link', async () => {
    const scenario = 'collab-flows';
    const channelId = await harness.createScenarioChannel(scenario, 'collab');
    const added = await harness.addManualCollaboratorConnection(harness.secrets.collabJinxxyApiKey);
    await harness.recordResource({
      scenario,
      type: 'collaborator_connection',
      id: added.connectionId,
    });

    const admin = await harness.openAdminSession();

    try {
      const page = await admin.openChannel(harness.secrets.targetGuildId, channelId);
      await admin.runSlashCommand(
        page,
        '/creator-admin collab invite',
        'Collaborator invite link:'
      );
      await admin.waitForText(page, 'collab-invite');

      await admin.runSlashCommand(page, '/creator-admin collab list', 'Collaborator Connections');
      await admin.waitForText(page, added.displayName);
      await admin.clickButton(
        page,
        `Remove ${added.displayName}`,
        'Collaborator connection removed.'
      );

      const remaining = await harness.listCollaboratorConnections();
      expect(remaining.some((connection) => connection.id === added.connectionId)).toBe(false);

      await admin.close();
    } finally {
      await safeCleanup(harness, scenario, async () => {
        await admin.close().catch(() => {});
        await harness.cleanupScenario(scenario);
      });
    }
  });

  it('lists real suspicious subjects after a live moderation-state mutation', async () => {
    const scenario = 'moderation-list';
    const channelId = await harness.createScenarioChannel(scenario, 'moderation');
    const subjectId = await harness.ensureSubjectForDiscord(
      harness.secrets.memberUserId,
      `bot-e2e-member-${harness.runId}`
    );
    await harness.markSubjectSuspicious(subjectId, 'piracy');

    const admin = await harness.openAdminSession();

    try {
      const page = await admin.openChannel(harness.secrets.targetGuildId, channelId);
      await admin.runSlashCommand(page, '/creator-admin moderation list', 'Flagged Accounts');
      await admin.waitForAnyText(page, ['piracy', 'Flagged Accounts']);

      const suspiciousSubjects = await harness.listSuspiciousSubjects();
      expect(
        suspiciousSubjects.some(
          (subject) =>
            subject.subjectId === subjectId &&
            subject.discordUserId === harness.secrets.memberUserId
        )
      ).toBe(true);

      await admin.close();
    } finally {
      await safeCleanup(harness, scenario, async () => {
        await harness.clearSubjectSuspicious(subjectId).catch(() => {});
        await admin.close().catch(() => {});
        await harness.cleanupScenario(scenario);
      });
    }
  });
});
