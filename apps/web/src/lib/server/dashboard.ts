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

/**
 * Fetches the user's Discord guilds that have the bot installed.
 * Used by the dashboard sidebar to populate the guild picker.
 */
export const fetchGuilds = createServerFn({ method: 'GET' }).handler(async (): Promise<Guild[]> => {
  const token = await getToken();
  if (!token) {
    throw new Error('Not authenticated');
  }

  return serverApiFetch<Guild[]>('/api/dashboard/guilds', {
    authToken: token,
  });
});
