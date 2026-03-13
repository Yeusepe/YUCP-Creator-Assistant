import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cwd } from 'node:process';
import { type BotE2ESecrets, requireBotE2ESecrets } from '@yucp/shared/test/loadBotE2ESecrets';
import { ConvexHttpClient } from 'convex/browser';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const ARTIFACT_DIR = join(cwd(), 'apps', 'bot', 'test', 'e2e', '.artifacts');
const SERVICE_BOOT_TIMEOUT_MS = 120_000;
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;

type ResourceType =
  | 'channel'
  | 'role'
  | 'role_rule'
  | 'download_route'
  | 'collaborator_connection'
  | 'product'
  | 'subject'
  | 'note';

interface ManifestResource {
  scenario: string;
  type: ResourceType;
  id: string;
  guildId?: string;
  metadata?: Record<string, unknown>;
}

interface CleanupFailure {
  scenario: string;
  step: string;
  error: string;
}

interface HarnessManifest {
  runId: string;
  startedAt: string;
  manifestPath: string;
  resources: ManifestResource[];
  cleanupFailures: CleanupFailure[];
}

interface DiscordCommandOption {
  type: number;
  name: string;
  description?: string;
  options?: DiscordCommandOption[];
}

interface DiscordGuildCommand {
  id: string;
  name: string;
  description: string;
  options?: DiscordCommandOption[];
}

interface DiscordGuildMember {
  user: {
    id: string;
    username: string;
  };
  roles: string[];
}

interface DiscordChannelMessage {
  id: string;
  author: {
    id: string;
    username: string;
  };
  content: string;
  attachments: Array<{
    id: string;
    filename: string;
    url: string;
  }>;
}

interface TenantRecord {
  _id: string;
  policy?: Record<string, unknown>;
}

interface DownloadRouteRecord {
  _id: string;
  enabled: boolean;
  sourceChannelId: string;
  archiveChannelId: string;
  messageTitle: string;
  messageBody: string;
  requiredRoleIds: string[];
  roleLogic: 'all' | 'any';
}

interface CollaboratorConnectionRecord {
  id: string;
  status: string;
  collaboratorDisplayName: string;
  collaboratorDiscordUserId: string;
  linkType: 'account' | 'api';
}

interface SuspiciousSubjectRecord {
  subjectId: string;
  discordUserId: string;
  displayName?: string;
  reason?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

function decodeStorageState(base64: string): {
  cookies: Array<Record<string, unknown>>;
  origins: Array<Record<string, unknown>>;
} {
  const raw = Buffer.from(base64, 'base64').toString('utf8');
  return JSON.parse(raw) as {
    cookies: Array<Record<string, unknown>>;
    origins: Array<Record<string, unknown>>;
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parsePort(url: string): number {
  const parsed = new URL(url);
  return parsed.port ? Number.parseInt(parsed.port, 10) : parsed.protocol === 'https:' ? 443 : 80;
}

class ManagedProcess {
  private readonly child: ChildProcess;
  private stdoutBuffer = '';
  private stderrBuffer = '';

  constructor(cmd: string, args: string[], env: NodeJS.ProcessEnv) {
    this.child = spawn(cmd, args, {
      cwd: cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!this.child.stdout || !this.child.stderr) {
      throw new Error(`Failed to spawn managed process for ${cmd}`);
    }
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
    });
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer += chunk;
    });
  }

  async waitForOutput(
    pattern: RegExp | string,
    timeoutMs = SERVICE_BOOT_TIMEOUT_MS
  ): Promise<void> {
    const matcher = typeof pattern === 'string' ? new RegExp(escapeRegExp(pattern)) : pattern;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (matcher.test(this.stdoutBuffer) || matcher.test(this.stderrBuffer)) {
        return;
      }
      if (this.child.exitCode !== null) {
        throw new Error(
          `Process exited before emitting ${matcher}: stdout=${this.stdoutBuffer}\nstderr=${this.stderrBuffer}`
        );
      }
      await delay(250);
    }

    throw new Error(
      `Timed out waiting for ${matcher}: stdout=${this.stdoutBuffer}\nstderr=${this.stderrBuffer}`
    );
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null) {
      return;
    }

    this.child.kill('SIGTERM');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) {
        return;
      }
      await delay(250);
    }
    this.child.kill('SIGKILL');
  }
}

export class DiscordBotE2EHarness {
  readonly runId: string;
  readonly secrets: BotE2ESecrets;
  readonly convex: ConvexHttpClient;
  readonly manifest: HarnessManifest;
  private readonly browser: Browser;
  private readonly apiProcess: ManagedProcess;
  private readonly botProcess: ManagedProcess;
  private readonly env: NodeJS.ProcessEnv;

  private constructor(args: {
    runId: string;
    secrets: BotE2ESecrets;
    convex: ConvexHttpClient;
    browser: Browser;
    apiProcess: ManagedProcess;
    botProcess: ManagedProcess;
    env: NodeJS.ProcessEnv;
    manifest: HarnessManifest;
  }) {
    this.runId = args.runId;
    this.secrets = args.secrets;
    this.convex = args.convex;
    this.browser = args.browser;
    this.apiProcess = args.apiProcess;
    this.botProcess = args.botProcess;
    this.env = args.env;
    this.manifest = args.manifest;
  }

  static async start(): Promise<DiscordBotE2EHarness> {
    const secrets = await requireBotE2ESecrets();
    const runId = `bot-e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
    await mkdir(ARTIFACT_DIR, { recursive: true });
    const manifestPath = join(ARTIFACT_DIR, `${runId}.json`);
    const manifest: HarnessManifest = {
      runId,
      startedAt: nowIso(),
      manifestPath,
      resources: [],
      cleanupFailures: [],
    };

    const env = {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(parsePort(secrets.apiBaseUrl)),
      HOST: '127.0.0.1',
      BETTER_AUTH_URL: secrets.apiBaseUrl,
      DISCORD_BOT_TOKEN: secrets.discordBotToken,
      DISCORD_CLIENT_ID: secrets.discordClientId,
      DISCORD_CLIENT_SECRET: secrets.discordClientSecret,
      DISCORD_GUILD_ID: secrets.targetGuildId,
      CONVEX_URL: secrets.convexUrl,
      CONVEX_API_SECRET: secrets.convexApiSecret,
      API_BASE_URL: secrets.apiBaseUrl,
      API_INTERNAL_URL: secrets.apiInternalUrl,
      FRONTEND_URL: secrets.frontendUrl,
      BETTER_AUTH_SECRET: secrets.betterAuthSecret,
      BOT_LOGIN_TIMEOUT_MS: '90000',
      LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
    };

    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const apiProcess = new ManagedProcess(process.execPath, ['run', 'apps/api/src/index.ts'], env);
    await waitForHealthcheck(secrets.apiBaseUrl);
    await apiProcess.waitForOutput(/API server ready/);

    const botProcess = new ManagedProcess(process.execPath, ['run', 'apps/bot/src/index.ts'], env);
    await botProcess.waitForOutput(/Discord bot ready/);

    const browser = await chromium.launch({
      headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
    });

    const harness = new DiscordBotE2EHarness({
      runId,
      secrets,
      convex: new ConvexHttpClient(secrets.convexUrl),
      browser,
      apiProcess,
      botProcess,
      env,
      manifest,
    });

    await harness.waitForRegisteredCommands();
    return harness;
  }

  get apiBaseUrl(): string {
    return this.secrets.apiBaseUrl;
  }

  async stop(): Promise<void> {
    await this.browser.close();
    await this.botProcess.stop();
    await this.apiProcess.stop();
  }

  async persistManifest(): Promise<void> {
    await writeFile(this.manifest.manifestPath, JSON.stringify(this.manifest, null, 2), 'utf8');
  }

  async recordResource(resource: ManifestResource): Promise<void> {
    this.manifest.resources.push(resource);
    await this.persistManifest();
  }

  async recordCleanupFailure(scenario: string, step: string, error: unknown): Promise<void> {
    this.manifest.cleanupFailures.push({
      scenario,
      step,
      error: error instanceof Error ? error.message : String(error),
    });
    await this.persistManifest();
  }

  async openAdminSession(): Promise<DiscordWebSession> {
    return this.openWebSession(this.secrets.adminStorageStateB64);
  }

  async openMemberSession(): Promise<DiscordWebSession> {
    return this.openWebSession(this.secrets.memberStorageStateB64);
  }

  private async openWebSession(storageStateB64: string): Promise<DiscordWebSession> {
    const storageState = decodeStorageState(storageStateB64) as NonNullable<
      Parameters<typeof this.browser.newContext>[0]
    >['storageState'];
    const context = await this.browser.newContext({
      storageState,
    });
    return new DiscordWebSession(context);
  }

  async waitForRegisteredCommands(): Promise<DiscordGuildCommand[]> {
    return await poll(
      async () => {
        const commands = await this.fetchGuildCommands(this.secrets.targetGuildId);
        const creator = commands.find((command) => command.name === 'creator');
        const creatorAdmin = commands.find((command) => command.name === 'creator-admin');
        if (!creator || !creatorAdmin) {
          return null;
        }
        return commands;
      },
      SERVICE_BOOT_TIMEOUT_MS,
      'creator and creator-admin slash command registration'
    );
  }

  async fetchGuildCommands(guildId: string): Promise<DiscordGuildCommand[]> {
    return await this.discordRequest<DiscordGuildCommand[]>(
      'GET',
      `/applications/${this.secrets.discordClientId}/guilds/${guildId}/commands`
    );
  }

  async createTextChannel(guildId: string, name: string): Promise<string> {
    const channel = await this.discordRequest<{ id: string }>(
      'POST',
      `/guilds/${guildId}/channels`,
      {
        name,
        type: 0,
      }
    );
    return channel.id;
  }

  async deleteChannel(channelId: string): Promise<void> {
    await this.discordRequest('DELETE', `/channels/${channelId}`);
  }

  async createRole(guildId: string, name: string, color = 0x5865f2): Promise<string> {
    const role = await this.discordRequest<{ id: string }>('POST', `/guilds/${guildId}/roles`, {
      name,
      color,
      mentionable: false,
      hoist: false,
    });
    return role.id;
  }

  async deleteRole(guildId: string, roleId: string): Promise<void> {
    await this.discordRequest('DELETE', `/guilds/${guildId}/roles/${roleId}`);
  }

  async addRoleToMember(guildId: string, userId: string, roleId: string): Promise<void> {
    await this.discordRequest('PUT', `/guilds/${guildId}/members/${userId}/roles/${roleId}`);
  }

  async removeRoleFromMember(guildId: string, userId: string, roleId: string): Promise<void> {
    await this.discordRequest('DELETE', `/guilds/${guildId}/members/${userId}/roles/${roleId}`);
  }

  async fetchMember(guildId: string, userId: string): Promise<DiscordGuildMember> {
    return await this.discordRequest<DiscordGuildMember>(
      'GET',
      `/guilds/${guildId}/members/${userId}`
    );
  }

  async waitForMemberRole(guildId: string, userId: string, roleId: string): Promise<void> {
    await poll(
      async () => {
        const member = await this.fetchMember(guildId, userId);
        return member.roles.includes(roleId) ? true : null;
      },
      DEFAULT_WAIT_TIMEOUT_MS,
      `member ${userId} gaining role ${roleId}`
    );
  }

  async waitForMemberRoleRemoval(guildId: string, userId: string, roleId: string): Promise<void> {
    await poll(
      async () => {
        const member = await this.fetchMember(guildId, userId);
        return member.roles.includes(roleId) ? null : true;
      },
      DEFAULT_WAIT_TIMEOUT_MS,
      `member ${userId} losing role ${roleId}`
    );
  }

  async fetchChannelMessages(channelId: string, limit = 20): Promise<DiscordChannelMessage[]> {
    return await this.discordRequest<DiscordChannelMessage[]>(
      'GET',
      `/channels/${channelId}/messages?limit=${limit}`
    );
  }

  async convexQuery<T>(name: string, args: Record<string, unknown>): Promise<T> {
    return (await this.convex.query(name as never, args as never)) as T;
  }

  async convexMutation<T>(name: string, args: Record<string, unknown>): Promise<T> {
    return (await this.convex.mutation(name as never, args as never)) as T;
  }

  async ensureSubjectForDiscord(discordUserId: string, displayName: string): Promise<string> {
    const result = await this.convexMutation<{ subjectId: string }>(
      'subjects:ensureSubjectForDiscord',
      {
        apiSecret: this.secrets.convexApiSecret,
        discordUserId,
        displayName,
      }
    );
    return result.subjectId;
  }

  async getSubjectByDiscordId(discordUserId: string): Promise<{
    found: boolean;
    subject: { _id: string } | null;
  }> {
    return await this.convexQuery('subjects:getSubjectByDiscordId', {
      apiSecret: this.secrets.convexApiSecret,
      discordUserId,
    });
  }

  async getTenant(): Promise<TenantRecord | null> {
    return await this.convexQuery<TenantRecord | null>('creatorProfiles:getCreatorProfile', {
      apiSecret: this.secrets.convexApiSecret,
      authUserId: this.secrets.authUserId,
    });
  }

  async updateTenantPolicy(policy: Record<string, unknown>): Promise<void> {
    await this.convexMutation('creatorProfiles:updateCreatorPolicy', {
      apiSecret: this.secrets.convexApiSecret,
      authUserId: this.secrets.authUserId,
      policy,
    });
  }

  async createRoleRule(params: { productId: string; verifiedRoleId: string }): Promise<string> {
    const result = await this.convexMutation<{ ruleId: string }>('role_rules:createRoleRule', {
      apiSecret: this.secrets.convexApiSecret,
      authUserId: this.secrets.authUserId,
      guildId: this.secrets.targetGuildId,
      guildLinkId: this.secrets.guildLinkId,
      productId: params.productId,
      verifiedRoleId: params.verifiedRoleId,
      removeOnRevoke: true,
      enabled: true,
      priority: 100,
    });
    return result.ruleId;
  }

  async deleteRoleRule(ruleId: string): Promise<void> {
    await this.convexMutation('role_rules:deleteRoleRule', {
      apiSecret: this.secrets.convexApiSecret,
      ruleId,
    });
  }

  async addDiscordRoleProductRule(params: {
    sourceGuildId: string;
    requiredRoleIds: string[];
    verifiedRoleIds: string[];
    requiredRoleMatchMode?: 'all' | 'any';
    guildId?: string;
    guildLinkId?: string;
  }): Promise<{ productId: string; ruleId: string }> {
    return await this.convexMutation<{ productId: string; ruleId: string }>(
      'role_rules:addProductFromDiscordRole',
      {
        apiSecret: this.secrets.convexApiSecret,
        authUserId: this.secrets.authUserId,
        sourceGuildId: params.sourceGuildId,
        requiredRoleIds: params.requiredRoleIds,
        requiredRoleMatchMode: params.requiredRoleMatchMode ?? 'any',
        guildId: params.guildId ?? this.secrets.targetGuildId,
        guildLinkId: params.guildLinkId ?? this.secrets.guildLinkId,
        verifiedRoleIds: params.verifiedRoleIds,
      }
    );
  }

  async grantManualEntitlement(
    subjectId: string,
    productId: string,
    sourceReference: string
  ): Promise<string> {
    const result = await this.convexMutation<{ entitlementId: string }>(
      'entitlements:grantEntitlement',
      {
        apiSecret: this.secrets.convexApiSecret,
        authUserId: this.secrets.authUserId,
        subjectId,
        productId,
        evidence: {
          provider: 'manual',
          sourceReference,
        },
      }
    );
    return result.entitlementId;
  }

  async revokeProductEntitlements(discordUserId: string, productId: string): Promise<void> {
    await this.convexMutation('entitlements:revokeEntitlementsByProduct', {
      apiSecret: this.secrets.convexApiSecret,
      authUserId: this.secrets.authUserId,
      discordUserId,
      productId,
    });
  }

  async createDownloadRoute(params: {
    sourceChannelId: string;
    archiveChannelId: string;
    requiredRoleIds: string[];
    roleLogic: 'all' | 'any';
    allowedExtensions: string[];
    messageTitle: string;
    messageBody: string;
  }): Promise<string> {
    const result = await this.convexMutation<{ routeId: string }>('downloads:createRoute', {
      apiSecret: this.secrets.convexApiSecret,
      authUserId: this.secrets.authUserId,
      guildId: this.secrets.targetGuildId,
      guildLinkId: this.secrets.guildLinkId,
      sourceChannelId: params.sourceChannelId,
      archiveChannelId: params.archiveChannelId,
      messageTitle: params.messageTitle,
      messageBody: params.messageBody,
      requiredRoleIds: params.requiredRoleIds,
      roleLogic: params.roleLogic,
      allowedExtensions: params.allowedExtensions,
      enabled: true,
    });
    return result.routeId;
  }

  async deleteDownloadRoute(routeId: string): Promise<void> {
    await this.convexMutation('downloads:deleteRoute', {
      apiSecret: this.secrets.convexApiSecret,
      routeId,
    });
  }

  async getDownloadRoute(routeId: string): Promise<DownloadRouteRecord | null> {
    return await this.convexQuery<DownloadRouteRecord | null>('downloads:getRouteById', {
      apiSecret: this.secrets.convexApiSecret,
      routeId,
    });
  }

  async waitForDownloadArtifact(routeId: string): Promise<Array<{ _id: string }>> {
    return await poll(
      async () => {
        const artifacts = await this.convexQuery<Array<{ _id: string }>>(
          'downloads:listActiveArtifactsByRoute',
          {
            apiSecret: this.secrets.convexApiSecret,
            routeId,
          }
        );
        return artifacts.length > 0 ? artifacts : null;
      },
      DEFAULT_WAIT_TIMEOUT_MS,
      `download artifact for route ${routeId}`
    );
  }

  async markSubjectSuspicious(subjectId: string, reason: string): Promise<void> {
    await this.convexMutation('identitySync:markSubjectSuspicious', {
      apiSecret: this.secrets.convexApiSecret,
      subjectId,
      reason,
      actorId: this.secrets.adminUserId,
      authUserId: this.secrets.authUserId,
      quarantine: true,
    });
  }

  async clearSubjectSuspicious(subjectId: string): Promise<void> {
    await this.convexMutation('identitySync:clearSubjectSuspicious', {
      apiSecret: this.secrets.convexApiSecret,
      subjectId,
      actorId: this.secrets.adminUserId,
      authUserId: this.secrets.authUserId,
    });
  }

  async listSuspiciousSubjects(): Promise<SuspiciousSubjectRecord[]> {
    return await this.convexQuery<SuspiciousSubjectRecord[]>(
      'identitySync:listSuspiciousSubjects',
      {
        apiSecret: this.secrets.convexApiSecret,
        authUserId: this.secrets.authUserId,
        limit: 25,
      }
    );
  }

  async createSetupSessionToken(
    discordUserId: string,
    guildId = this.secrets.targetGuildId
  ): Promise<string> {
    const response = await this.apiRequest<{ token: string }>('POST', '/api/setup/create-session', {
      body: {
        authUserId: this.secrets.authUserId,
        guildId,
        discordUserId,
        apiSecret: this.secrets.convexApiSecret,
      },
    });
    return response.token;
  }

  async addManualCollaboratorConnection(apiKey: string): Promise<{
    connectionId: string;
    displayName: string;
  }> {
    const token = await this.createSetupSessionToken(this.secrets.adminUserId);
    return await this.apiRequest<{ connectionId: string; displayName: string }>(
      'POST',
      '/api/collab/connections/manual',
      {
        token,
        body: {
          jinxxyApiKey: apiKey,
          serverName: 'Discord Bot E2E',
        },
      }
    );
  }

  async removeCollaboratorConnection(connectionId: string): Promise<void> {
    const token = await this.createSetupSessionToken(this.secrets.adminUserId);
    await this.apiRequest('DELETE', `/api/collab/connections/${connectionId}`, {
      token,
    });
  }

  async listCollaboratorConnections(): Promise<CollaboratorConnectionRecord[]> {
    return await this.convexQuery<CollaboratorConnectionRecord[]>(
      'collaboratorInvites:listCollaboratorConnections',
      {
        apiSecret: this.secrets.convexApiSecret,
        ownerAuthUserId: this.secrets.authUserId,
      }
    );
  }

  async createScenarioChannel(
    scenario: string,
    suffix: string,
    guildId = this.secrets.targetGuildId
  ): Promise<string> {
    const channelId = await this.createTextChannel(
      guildId,
      `${this.runId}-${scenario}-${suffix}`.slice(0, 90)
    );
    await this.recordResource({
      scenario,
      type: 'channel',
      id: channelId,
      guildId,
    });
    return channelId;
  }

  async createScenarioRole(
    scenario: string,
    suffix: string,
    guildId = this.secrets.targetGuildId
  ): Promise<string> {
    const roleId = await this.createRole(
      guildId,
      `${this.runId}-${scenario}-${suffix}`.slice(0, 90)
    );
    await this.recordResource({
      scenario,
      type: 'role',
      id: roleId,
      guildId,
    });
    return roleId;
  }

  async noteScenario(
    scenario: string,
    id: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await this.recordResource({
      scenario,
      type: 'note',
      id,
      metadata,
    });
  }

  async cleanupScenario(scenario: string): Promise<void> {
    const resources = this.manifest.resources.filter((resource) => resource.scenario === scenario);
    const reversed = [...resources].reverse();

    for (const resource of reversed) {
      try {
        if (resource.type === 'download_route') {
          await this.deleteDownloadRoute(resource.id);
        } else if (resource.type === 'collaborator_connection') {
          await this.removeCollaboratorConnection(resource.id);
        } else if (resource.type === 'role_rule') {
          await this.deleteRoleRule(resource.id);
        } else if (resource.type === 'role' && resource.guildId) {
          await this.deleteRole(resource.guildId, resource.id);
        } else if (resource.type === 'channel') {
          await this.deleteChannel(resource.id);
        } else if (resource.type === 'product') {
          const discordUserId = String(
            resource.metadata?.discordUserId ?? this.secrets.memberUserId
          );
          await this.revokeProductEntitlements(discordUserId, resource.id);
        } else if (resource.type === 'note') {
        }
      } catch (error) {
        await this.recordCleanupFailure(scenario, `${resource.type}:${resource.id}`, error);
      }
    }
  }

  private async apiRequest<T = unknown>(
    method: string,
    path: string,
    options?: {
      token?: string;
      body?: Record<string, unknown>;
    }
  ): Promise<T> {
    const response = await fetch(new URL(path, this.secrets.apiInternalUrl), {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(options?.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options?.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API ${method} ${path} failed: ${response.status} ${text}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private async discordRequest<T = unknown>(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const response = await fetch(`${DISCORD_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${this.secrets.discordBotToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Discord REST ${method} ${path} failed: ${response.status} ${text}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}

export class DiscordWebSession {
  private readonly context: BrowserContext;

  constructor(context: BrowserContext) {
    this.context = context;
  }

  async close(): Promise<void> {
    await this.context.close();
  }

  async openChannel(guildId: string, channelId: string): Promise<Page> {
    const page = await this.context.newPage();
    await page.goto(`https://discord.com/channels/${guildId}/${channelId}`, {
      waitUntil: 'domcontentloaded',
    });
    await page
      .waitForLoadState('networkidle', { timeout: DEFAULT_WAIT_TIMEOUT_MS })
      .catch(() => {});
    await page.waitForSelector('[role="textbox"]', { timeout: DEFAULT_WAIT_TIMEOUT_MS });
    return page;
  }

  async runSlashCommand(page: Page, command: string, expectedText?: string): Promise<void> {
    const composer = page.locator('[role="textbox"]').last();
    await composer.click();
    await page.keyboard.insertText(command);
    await delay(1000);
    await page.keyboard.press('Enter');
    await delay(400);
    await page.keyboard.press('Enter');
    if (expectedText) {
      await this.waitForText(page, expectedText);
    }
  }

  async waitForText(page: Page, text: string, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<void> {
    await page.getByText(text, { exact: false }).waitFor({
      state: 'visible',
      timeout: timeoutMs,
    });
  }

  async waitForAnyText(
    page: Page,
    texts: string[],
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      for (const text of texts) {
        const visible = await page
          .getByText(text, { exact: false })
          .first()
          .isVisible()
          .catch(() => false);
        if (visible) {
          return text;
        }
      }
      await delay(250);
    }

    throw new Error(`Timed out waiting for any of: ${texts.join(', ')}`);
  }

  async clickButton(page: Page, label: string, expectedText?: string): Promise<void> {
    await page.getByRole('button', { name: label, exact: false }).click();
    if (expectedText) {
      await this.waitForText(page, expectedText);
    }
  }

  async uploadFile(page: Page, filePath: string, messageText?: string): Promise<void> {
    const attachButton = page.getByRole('button', { name: /upload/i }).first();
    const chooserPromise = page.waitForEvent('filechooser');
    await attachButton.click();
    const chooser = await chooserPromise;
    await chooser.setFiles(filePath);
    if (messageText) {
      const composer = page.locator('[role="textbox"]').last();
      await composer.click();
      await page.keyboard.insertText(messageText);
    }
    await delay(1500);
    await page.keyboard.press('Enter');
  }
}

export async function waitForHealthcheck(baseUrl: string): Promise<void> {
  const deadline = Date.now() + SERVICE_BOOT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/health', baseUrl), { method: 'GET' });
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until the deadline.
    }
    await delay(500);
  }

  throw new Error(`Timed out waiting for API healthcheck at ${baseUrl}`);
}

async function poll<T>(
  run: () => Promise<T | null>,
  timeoutMs: number,
  description: string
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await run();
    if (result !== null) {
      return result;
    }
    await delay(500);
  }

  throw new Error(`Timed out waiting for ${description}`);
}

export async function safeCleanup(
  harness: DiscordBotE2EHarness,
  scenario: string,
  cleanup: () => Promise<void>
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    await harness.recordCleanupFailure(scenario, 'scenario', error);
  }
}

export async function ensureArtifactDir(): Promise<string> {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  return ARTIFACT_DIR;
}

export async function resetArtifactDir(): Promise<void> {
  await rm(ARTIFACT_DIR, { recursive: true, force: true });
}
