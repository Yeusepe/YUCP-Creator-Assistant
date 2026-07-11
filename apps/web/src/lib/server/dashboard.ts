import { createServerFn } from '@tanstack/react-start';
import { getResponseHeader, setResponseHeader } from '@tanstack/react-start/server';
import { logWebError } from '../webDiagnostics';
import { type ServerTimingMetric, serverApiFetch } from './api-client';
import { withWebServerRequestSpan, withWebServerSpan } from './observability';

/**
 * Server functions for the dashboard layout and its child routes.
 * These run on the TanStack Start server and call the Bun API
 * server-to-server, authenticated via INTERNAL_RPC_SHARED_SECRET.
 */

export interface Guild {
  id: string;
  name: string;
  icon: string | null;
  tenantId?: string;
}

export interface DashboardViewer {
  authUserId: string;
  name: string | null;
  email: string | null;
  image: string | null;
  discordUserId: string | null;
}

export interface DashboardBranding {
  isPlus: boolean;
  billingStatus: string | null;
}

export interface DashboardUserAccountConnection {
  id: string;
  provider: string;
  label: string;
  connectionType: string;
  status: string;
  webhookConfigured: boolean;
  hasApiKey: boolean;
  hasAccessToken: boolean;
  authUserId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DashboardPolicy {
  allowMismatchedEmails?: boolean;
  autoVerifyOnJoin?: boolean;
  shareVerificationWithServers?: boolean;
  enableDiscordRoleFromOtherServers?: boolean;
  verificationScope?: 'account' | 'license';
  duplicateVerificationBehavior?: 'allow' | 'notify' | 'block';
  suspiciousAccountBehavior?: 'notify' | 'quarantine' | 'revoke';
  logChannelId?: string;
  announcementsChannelId?: string;
}

export interface DashboardShellData {
  viewer: DashboardViewer;
  branding: DashboardBranding;
  guilds: Guild[];
  home?: {
    providers: DashboardProvider[];
    userAccounts: DashboardUserAccountConnection[];
    connectionStatusAuthUserId: string;
    connectionStatusByProvider: Record<string, boolean>;
  };
  selectedServer?: {
    authUserId: string;
    guildId: string;
    policy: DashboardPolicy;
  };
}

export interface DashboardProvider {
  key: string;
  setupExperience?: 'automatic' | 'guided' | 'manual';
  setupHint?: string;
  label?: string;
  icon?: string;
  iconBg?: string;
  quickStartBg?: string;
  quickStartBorder?: string;
  serverTileHint?: string;
  connectPath?: string;
  connectParamStyle?: 'camelCase' | 'snakeCase';
}

interface GuildResponse {
  authUserId: string;
  guildId: string;
  name: string;
  icon: string | null;
}

interface DashboardShellResponse {
  viewer?: {
    authUserId?: string;
    name?: string | null;
    email?: string | null;
    image?: string | null;
    discordUserId?: string | null;
  } | null;
  branding?: {
    isPlus?: boolean;
    billingStatus?: string | null;
  } | null;
  guilds?: GuildResponse[];
  home?: DashboardShellData['home'];
  selectedServer?: DashboardShellData['selectedServer'];
}

interface DashboardShellRequest {
  authUserId?: string;
  guildId?: string;
  includeHomeData?: boolean;
}

function logDashboardInfo(event: string, context: Record<string, unknown>): void {
  console.info(`[web] ${event}`, context);
}

function stripQuotes(value: string): string {
  return value.replace(/^"|"$/g, '');
}

function roundDuration(value: number) {
  return Number(value.toFixed(1));
}

function formatServerTimingHeader(metrics: ServerTimingMetric[]): string {
  return metrics
    .filter((metric) => metric.name.length > 0 && Number.isFinite(metric.durationMs))
    .map((metric) => `${metric.name};dur=${roundDuration(metric.durationMs)}`)
    .join(', ');
}

function appendServerTimingMetrics(metrics: ServerTimingMetric[]) {
  if (metrics.length === 0) {
    return;
  }

  const existing = getResponseHeader('Server-Timing');
  const nextValue = formatServerTimingHeader(metrics);
  if (!nextValue) {
    return;
  }

  setResponseHeader('Server-Timing', existing ? `${existing}, ${nextValue}` : nextValue);
}

function normalizeGuild(guild: GuildResponse): Guild {
  return {
    id: stripQuotes(guild.guildId),
    name: guild.name,
    icon: guild.icon ?? null,
    tenantId: stripQuotes(guild.authUserId),
  };
}

function normalizeDashboardShellResponse(response: DashboardShellResponse): DashboardShellData {
  return {
    viewer: normalizeDashboardViewer(response.viewer),
    branding: {
      isPlus: response.branding?.isPlus === true,
      billingStatus:
        typeof response.branding?.billingStatus === 'string' &&
        response.branding.billingStatus.length > 0
          ? response.branding.billingStatus
          : null,
    },
    guilds: (response.guilds ?? []).map(normalizeGuild),
    home: response.home
      ? {
          ...response.home,
          connectionStatusAuthUserId: stripQuotes(response.home.connectionStatusAuthUserId),
        }
      : undefined,
    selectedServer: response.selectedServer
      ? {
          ...response.selectedServer,
          authUserId: stripQuotes(response.selectedServer.authUserId),
          guildId: stripQuotes(response.selectedServer.guildId),
        }
      : undefined,
  };
}

function normalizeDashboardViewer(
  viewer: DashboardShellResponse['viewer']
): DashboardShellData['viewer'] {
  const authUserId = stripQuotes(viewer?.authUserId ?? '');
  if (!authUserId) {
    throw new Error('Dashboard shell response is missing the authenticated viewer');
  }

  return {
    authUserId,
    name: viewer?.name ?? null,
    email: viewer?.email ?? null,
    image: viewer?.image ?? null,
    discordUserId: viewer?.discordUserId ?? null,
  };
}

export const fetchDashboardShell = createServerFn({ method: 'GET' })
  .inputValidator((data: DashboardShellRequest | undefined) => data ?? {})
  .handler(async ({ data }: { data?: DashboardShellRequest }): Promise<DashboardShellData> => {
    return withWebServerRequestSpan(
      'serverFn.dashboard.shell',
      {
        'tanstack.serverfn': 'fetchDashboardShell',
        'dashboard.include_home_data': Boolean(data?.includeHomeData),
        'dashboard.has_guild_id': Boolean(data?.guildId),
        'dashboard.has_auth_user_id': Boolean(data?.authUserId),
      },
      async () =>
        withWebServerSpan(
          'web.dashboard.shell',
          {
            phase: 'dashboard-load-shell',
          },
          async () => {
            logDashboardInfo('Dashboard shell load started', {
              phase: 'dashboard-load-shell',
            });

            try {
              const requestStartedAt = performance.now();
              const params: Record<string, string> = {};
              if (data?.authUserId) {
                params.authUserId = data.authUserId;
              }
              if (data?.guildId) {
                params.guildId = data.guildId;
              }
              if (data?.includeHomeData) {
                params.includeHomeData = 'true';
              }
              const documentServerTimingMetrics: ServerTimingMetric[] = [];
              const response = await serverApiFetch<DashboardShellResponse>(
                '/api/connect/dashboard/shell',
                {
                  params: Object.keys(params).length > 0 ? params : undefined,
                  onServerTiming: (metrics) => {
                    for (const metric of metrics) {
                      documentServerTimingMetrics.push({
                        name: `dashboard-api-${metric.name.replace(/[^a-z0-9_-]/gi, '-')}`,
                        durationMs: metric.durationMs,
                      });
                    }
                  },
                }
              );
              documentServerTimingMetrics.unshift({
                name: 'dashboard-shell',
                durationMs: roundDuration(performance.now() - requestStartedAt),
              });
              appendServerTimingMetrics(documentServerTimingMetrics);
              const shell = normalizeDashboardShellResponse(response);

              logDashboardInfo('Dashboard shell load completed', {
                phase: 'dashboard-load-shell',
                guildCount: shell.guilds.length,
                hasHomeData: Boolean(shell.home),
                hasSelectedServer: Boolean(shell.selectedServer),
              });

              return shell;
            } catch (error) {
              logWebError('Dashboard shell load failed', error, {
                phase: 'dashboard-load-shell',
              });
              throw error;
            }
          }
        )
    );
  });
