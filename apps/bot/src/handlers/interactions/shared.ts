import { createLogger } from '@yucp/shared';
import { getApiUrls } from '../../lib/apiUrls';
import { createConnectToken } from '../../lib/internalRpc';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

/** Message when server has no guild link. forAdmin: securely fetch token to sign-in; otherwise tell user to ask admin. */
export async function getNotConfiguredMessage(
  guildId: string,
  discordUserId: string,
  _apiSecret: string,
  forAdmin = false
): Promise<string> {
  if (forAdmin) {
    const { apiInternal, apiPublic, webPublic } = getApiUrls();
    const linkBase = webPublic ?? apiPublic;
    if (linkBase) {
      try {
        if (apiInternal ?? apiPublic) {
          const token = await createConnectToken({ discordUserId, guildId });
          if (token) {
            return `This server is not configured. [Sign in to configure](${linkBase}/dashboard?guild_id=${guildId}#token=${token})`;
          }
        }
      } catch (e) {
        logger.error('Failed to generate secure connect token', { error: e });
      }
      return `This server is not configured. [Sign in to configure](${linkBase}/dashboard?guild_id=${guildId})`;
    }
    return 'This server is not configured. Please sign in to configure (API_BASE_URL not set).';
  }
  return "This server isn't set up for verification yet. Ask a server admin to configure it in the Creator Portal.";
}
