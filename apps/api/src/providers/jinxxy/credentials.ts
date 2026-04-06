import { JINXXY_PURPOSES } from '@yucp/providers/jinxxy/module';
import { api } from '../../../../../convex/_generated/api';
import { decrypt } from '../../lib/encrypt';
import { logger } from '../../lib/logger';
import type { ProviderContext } from '../types';

export const JINXXY_API_KEY_PURPOSE = JINXXY_PURPOSES.credential;

type JinxxyCredentialContext = Pick<ProviderContext, 'convex' | 'apiSecret' | 'encryptionSecret'>;

export async function decryptJinxxyApiKey(
  encryptedApiKey: string,
  encryptionSecret: string
): Promise<string> {
  return decrypt(encryptedApiKey, encryptionSecret, JINXXY_API_KEY_PURPOSE);
}

export async function resolveJinxxyCreatorApiKey(
  ctx: JinxxyCredentialContext,
  authUserId: string
): Promise<string | null> {
  const data = await ctx.convex.query(api.providerConnections.getConnectionForBackfill, {
    apiSecret: ctx.apiSecret,
    authUserId,
    provider: 'jinxxy',
  });
  const encryptedApiKey = data?.credentials.api_key;
  if (!encryptedApiKey) {
    return null;
  }

  try {
    return await decryptJinxxyApiKey(encryptedApiKey, ctx.encryptionSecret);
  } catch (err) {
    logger.error('Failed to decrypt Jinxxy API key', {
      authUserId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
