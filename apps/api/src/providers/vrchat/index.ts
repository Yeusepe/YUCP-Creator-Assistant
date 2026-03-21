/**
 * VRChat Provider Plugin
 *
 * Provides catalog_sync via the creator's own VRChat store:
 *   GET /api/1/user/{userId}/listings — requires the creator to be connected
 *   Source: https://vrchat.community/reference/get-product-listings
 *
 * The creator connects via /api/connect/vrchat/begin → /setup/vrchat?mode=connect.
 * Their session is stored encrypted in provider_connections with credentialKey='vrchat_session'.
 */

import { extractVrchatAvatarId } from '@yucp/providers';
import { VrchatApiClient } from '@yucp/providers/vrchat';
import { VrchatSessionExpiredError } from '@yucp/providers/vrchat/types';
import { createLogger } from '@yucp/shared';
import { api } from '../../../../../convex/_generated/api';
import { decrypt } from '../../lib/encrypt';
import type { ProductRecord, ProviderContext, ProviderPlugin, ProviderPurposes } from '../types';
import { CredentialExpiredError } from '../types';
import { vrchatConnect } from './connect';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

/**
 * HKDF purpose for the VRChat creator session.
 * Domain-separated from the buyer session ('vrchat-provider-session').
 * Source: agents.md §Security Principles — HKDF domain separation
 */
export const PURPOSES = {
  credential: 'vrchat-creator-session',
} as const satisfies ProviderPurposes;

const vrchatProvider: ProviderPlugin = {
  id: 'vrchat',
  needsCredential: true,
  purposes: PURPOSES,

  /**
   * Resolve and decrypt the creator's VRChat session from Convex.
   * Returns the session as a JSON string: '{"authToken":"...","twoFactorAuthToken":"..."}'
   * Returns null if the creator has not connected VRChat.
   */
  async getCredential(ctx: ProviderContext): Promise<string | null> {
    const data = await ctx.convex.query(api.providerConnections.getConnectionForBackfill, {
      apiSecret: ctx.apiSecret,
      authUserId: ctx.authUserId,
      provider: 'vrchat',
    });

    const encryptedSession = data?.credentials?.vrchat_session;
    if (!encryptedSession) return null;
    return decrypt(encryptedSession, ctx.encryptionSecret, PURPOSES.credential);
  },

  /**
   * Fetch the creator's VRChat store listings.
   *
   * Uses the creator's own session from getCredential() — NOT a random buyer session.
   * Maps each listing to { id: prod_xxx, name: displayName }.
   *
   * Throws CredentialExpiredError when the VRChat session has expired (HTTP 401).
   * The RPC router catches this and marks the connection as 'degraded'.
   */
  async fetchProducts(credential: string | null, _ctx: ProviderContext): Promise<ProductRecord[]> {
    if (!credential) return [];

    let session: { authToken: string; twoFactorAuthToken?: string };
    try {
      session = JSON.parse(credential) as typeof session;
    } catch {
      logger.warn('[vrchat] getCredential returned malformed JSON');
      return [];
    }

    const client = new VrchatApiClient();
    try {
      const listings = await client.getProductListings(session);
      return listings.map((listing) => ({ id: listing.id, name: listing.displayName }));
    } catch (err) {
      if (err instanceof VrchatSessionExpiredError) {
        throw new CredentialExpiredError('vrchat');
      }
      throw err;
    }
  },

  connect: vrchatConnect,
  displayMeta: {
    label: 'VRChat®',
    icon: 'VRC.png',
    color: '#00b48c',
    shadowColor: '#00b48c',
    textColor: '#ffffff',
    connectedColor: '#008a6b',
    confettiColors: ['#00b48c', '#008a6b', '#80ffd8', '#ffffff'],
    description: 'Store',
    dashboardConnectPath: '/setup/vrchat?mode=connect',
    dashboardConnectParamStyle: 'snakeCase',
    userSetupPath: '/setup/vrchat',
    dashboardIconBg: '#00b48c',
    dashboardQuickStartBg: 'rgba(0,180,140,0.1)',
    dashboardQuickStartBorder: 'rgba(0,180,140,0.3)',
    dashboardServerTileHint: 'Allow users to verify VRChat avatar access in this Discord server.',
  },
  async resolveProductName(
    credential: string | null,
    urlOrId: string,
    _ctx: ProviderContext
  ): Promise<{ name: string; error?: string }> {
    const avatarId = extractVrchatAvatarId(urlOrId);
    if (!avatarId) return { name: '', error: 'invalid_avatar_id' };
    if (!credential) return { name: '', error: 'not_connected' };

    let session: { authToken: string; twoFactorAuthToken?: string };
    try {
      session = JSON.parse(credential) as typeof session;
    } catch {
      return { name: '', error: 'credential_error' };
    }

    try {
      const client = new VrchatApiClient();
      const avatar = await client.getAvatarById(session, avatarId);
      return { name: avatar?.name ?? '', error: avatar ? undefined : 'not_found' };
    } catch (err) {
      if (err instanceof VrchatSessionExpiredError) {
        return { name: '', error: 'session_expired' };
      }
      throw err;
    }
  },
};

export default vrchatProvider;
