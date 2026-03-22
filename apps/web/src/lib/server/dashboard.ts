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

export interface DashboardShellData {
  viewer: DashboardViewer;
  guilds: Guild[];
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

function logDashboardInfo(event: string, context: Record<string, unknown>): void {
  console.info(`[web] ${event}`, context);
}

function stripQuotes(value: string): string {
  return value.replace(/^"|"$/g, '');
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

    const guilds = (response.guilds ?? []).map((guild) => ({
      id: stripQuotes(guild.guildId),
      name: guild.name,
      icon: guild.icon ?? null,
      tenantId: stripQuotes(guild.authUserId),
    }));

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

  try {
    const baseViewer = decodeDashboardViewer(token);
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
    throw error;
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

export const fetchDashboardShell = createServerFn({ method: 'GET' }).handler(
  async (): Promise<DashboardShellData> => {
    logDashboardInfo('Dashboard shell load started', {
      phase: 'dashboard-load-shell',
    });

    try {
      const token = await requireDashboardToken();
      const [viewer, guilds] = await Promise.all([loadDashboardViewer(token), loadGuilds(token)]);

      logDashboardInfo('Dashboard shell load completed', {
        phase: 'dashboard-load-shell',
        guildCount: guilds.length,
      });

      return {
        viewer,
        guilds,
      };
    } catch (error) {
      logWebError('Dashboard shell load failed', error, {
        phase: 'dashboard-load-shell',
      });
      throw error;
    }
  }
);
