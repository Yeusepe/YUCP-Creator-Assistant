import { createServerFn } from '@tanstack/react-start';
import { api } from '../../../../../convex/_generated/api';
import { fetchAuthQuery, getToken } from '../auth-server';
import { logWebError } from '../webDiagnostics';
import { serverApiFetch } from './api-client';

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

function normalizeGuild(guild: GuildResponse): Guild {
  return {
    id: stripQuotes(guild.guildId),
    name: guild.name,
    icon: guild.icon ?? null,
    tenantId: stripQuotes(guild.authUserId),
  };
}

function normalizeDashboardShellResponse(
  response: DashboardShellResponse,
  fallbackViewer: DashboardViewer
): DashboardShellData {
  return {
    viewer: {
      authUserId: response.viewer?.authUserId ?? fallbackViewer.authUserId,
      name: response.viewer?.name ?? null,
      email: response.viewer?.email ?? null,
      image: response.viewer?.image ?? null,
      discordUserId: response.viewer?.discordUserId ?? null,
    },
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

/**
 * Fetches the user's Discord guilds that have the bot installed.
 * Used by the dashboard sidebar to populate the guild picker.
 */
async function requireDashboardToken() {
  logDashboardInfo('Dashboard token fetch started', {
    phase: 'dashboard-require-token',
  });

  try {
    const token = await getToken();

    logDashboardInfo('Dashboard token fetch completed', {
      phase: 'dashboard-require-token',
      hasToken: Boolean(token),
    });

    if (!token) {
      throw new Error('Not authenticated');
    }

    return token;
  } catch (error) {
    logWebError('Dashboard token fetch failed', error, {
      phase: 'dashboard-require-token',
    });
    throw error;
  }
}

function decodeDashboardViewer(token: string): DashboardViewer {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')
    ) as {
      sub?: string;
    };

    if (!payload.sub) {
      throw new Error('Invalid auth token');
    }

    return {
      authUserId: payload.sub,
      name: null,
      email: null,
      image: null,
      discordUserId: null,
    };
  } catch (error) {
    logWebError('Dashboard viewer token decode failed', error, {
      phase: 'dashboard-decode-viewer',
      tokenSegmentCount: token.split('.').length,
    });
    throw error;
  }
}

async function loadGuilds(token: string): Promise<Guild[]> {
  logDashboardInfo('Dashboard guild load started', {
    phase: 'dashboard-load-guilds',
    hasToken: Boolean(token),
  });

  try {
    const response = await serverApiFetch<{ guilds?: GuildResponse[] }>(
      '/api/connect/user/guilds',
      {
        authToken: token,
      }
    );

    const guilds = (response.guilds ?? []).map(normalizeGuild);

    logDashboardInfo('Dashboard guild load completed', {
      phase: 'dashboard-load-guilds',
      guildCount: guilds.length,
    });

    return guilds;
  } catch (error) {
    logWebError('Dashboard guild load failed', error, {
      phase: 'dashboard-load-guilds',
    });
    throw error;
  }
}

async function loadDashboardViewer(token: string): Promise<DashboardViewer> {
  logDashboardInfo('Dashboard viewer load started', {
    phase: 'dashboard-load-viewer',
    hasToken: Boolean(token),
  });

  const baseViewer = decodeDashboardViewer(token);

  try {
    const viewer = await fetchAuthQuery(api.authViewer.getViewer, {});
    const dashboardViewer = {
      authUserId: baseViewer.authUserId,
      name: viewer?.name ?? null,
      email: viewer?.email ?? null,
      image: viewer?.image ?? null,
      discordUserId: viewer?.discordUserId ?? null,
    };

    logDashboardInfo('Dashboard viewer load completed', {
      phase: 'dashboard-load-viewer',
      hasViewerName: dashboardViewer.name !== null,
      hasDiscordUserId: dashboardViewer.discordUserId !== null,
    });

    return dashboardViewer;
  } catch (error) {
    logWebError('Dashboard viewer load failed', error, {
      phase: 'dashboard-load-viewer',
    });

    logDashboardInfo('Dashboard viewer load degraded', {
      phase: 'dashboard-load-viewer',
      fallbackToTokenClaims: true,
    });

    return baseViewer;
  }
}

/**
 * Fetches the user's Discord guilds that have the bot installed.
 * Used by the dashboard sidebar to populate the guild picker.
 */
export const fetchGuilds = createServerFn({ method: 'GET' }).handler(async (): Promise<Guild[]> => {
  const token = await requireDashboardToken();
  return loadGuilds(token);
});

/**
 * Fetches the list of available providers for the dashboard.
 */
export const fetchDashboardProviders = createServerFn({ method: 'GET' }).handler(
  async (): Promise<DashboardProvider[]> => {
    const token = await getToken();
    return serverApiFetch<DashboardProvider[]>('/api/providers', { authToken: token });
  }
);

export const fetchDashboardViewer = createServerFn({ method: 'GET' }).handler(
  async (): Promise<DashboardViewer> => {
    const token = await requireDashboardToken();
    return loadDashboardViewer(token);
  }
);

export const fetchDashboardShell = createServerFn({ method: 'GET' })
  .inputValidator((data: DashboardShellRequest | undefined) => data ?? {})
  .handler(async ({ data }: { data?: DashboardShellRequest }): Promise<DashboardShellData> => {
    logDashboardInfo('Dashboard shell load started', {
      phase: 'dashboard-load-shell',
    });

    try {
      const token = await requireDashboardToken();
      const baseViewer = decodeDashboardViewer(token);
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
      const response = await serverApiFetch<DashboardShellResponse>(
        '/api/connect/dashboard/shell',
        {
          authToken: token,
          params: Object.keys(params).length > 0 ? params : undefined,
        }
      );
      const shell = normalizeDashboardShellResponse(response, baseViewer);

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
  });
