import { createServerFn } from '@tanstack/react-start';
import { api } from '../../../../../convex/_generated/api';
import { fetchAuthQuery, getToken } from '../auth-server';
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

function stripQuotes(value: string): string {
  return value.replace(/^"|"$/g, '');
}

/**
 * Fetches the user's Discord guilds that have the bot installed.
 * Used by the dashboard sidebar to populate the guild picker.
 */
async function requireDashboardToken() {
  const token = await getToken();
  if (!token) {
    throw new Error('Not authenticated');
  }

  return token;
}

function decodeDashboardViewer(token: string): DashboardViewer {
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
}

async function loadGuilds(token: string): Promise<Guild[]> {
  const response = await serverApiFetch<{ guilds?: GuildResponse[] }>('/api/connect/user/guilds', {
    authToken: token,
  });

  return (response.guilds ?? []).map((guild) => ({
    id: stripQuotes(guild.guildId),
    name: guild.name,
    icon: guild.icon ?? null,
    tenantId: stripQuotes(guild.authUserId),
  }));
}

async function loadDashboardViewer(token: string): Promise<DashboardViewer> {
  const baseViewer = decodeDashboardViewer(token);
  const viewer = await fetchAuthQuery(api.authViewer.getViewer, {});

  return {
    authUserId: baseViewer.authUserId,
    name: viewer?.name ?? null,
    email: viewer?.email ?? null,
    image: viewer?.image ?? null,
    discordUserId: viewer?.discordUserId ?? null,
  };
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
    const token = await requireDashboardToken();
    const [viewer, guilds] = await Promise.all([loadDashboardViewer(token), loadGuilds(token)]);

    return {
      viewer,
      guilds,
    };
  }
);
