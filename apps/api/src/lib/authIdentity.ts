import { api } from '../../../../convex/_generated/api';
import type { ConvexServerClient } from './convex';

export async function resolveDiscordUserIdForAuthUser(
  convex: ConvexServerClient,
  apiSecret: string,
  authUserId: string
): Promise<string | null> {
  const discordUserId = await convex.query(api.authViewer.getDiscordUserIdByAuthUser, {
    apiSecret,
    authUserId,
  });

  return typeof discordUserId === 'string' && discordUserId.trim() ? discordUserId.trim() : null;
}
