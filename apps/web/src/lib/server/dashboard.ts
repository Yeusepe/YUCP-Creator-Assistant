import { createServerFn } from '@tanstack/react-start';
import { getToken } from '../auth-server';
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
}

interface GuildResponse {
  authUserId: string;
  guildId: string;
  name: string;
  icon: string | null;
}

/**
 * Fetches the user's Discord guilds that have the bot installed.
 * Used by the dashboard sidebar to populate the guild picker.
 */
export const fetchGuilds = createServerFn({ method: 'GET' }).handler(async (): Promise<Guild[]> => {
  const token = await getToken();
  if (!token) {
    throw new Error('Not authenticated');
  }

  const response = await serverApiFetch<{ guilds?: GuildResponse[] }>('/api/connect/user/guilds', {
    authToken: token,
  });
  return (response.guilds ?? []).map((guild) => ({
    id: guild.guildId,
    name: guild.name,
    icon: guild.icon ?? null,
    tenantId: guild.authUserId,
  }));
});

export const fetchDashboardViewer = createServerFn({ method: 'GET' }).handler(
  async (): Promise<DashboardViewer> => {
    const token = await getToken();
    if (!token) {
      throw new Error('Not authenticated');
    }

    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')
    ) as {
      sub?: string;
    };

    if (!payload.sub) {
      throw new Error('Invalid auth token');
    }

    return { authUserId: payload.sub };
  }
);
