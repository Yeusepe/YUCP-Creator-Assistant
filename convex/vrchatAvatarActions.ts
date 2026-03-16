"use node";

import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal, components } from './_generated/api';
import { VrchatWebClient } from './lib/vrchat/client';
import { decryptForPurpose } from './lib/vrchat/crypto';
import type { VrchatSessionTokens } from './lib/vrchat/types';

const ENCRYPTED_PREFIX = 'enc:v1:';
const PROVIDER_SESSION_PURPOSE = 'vrchat-provider-session';

/**
 * Decrypts a stored VRChat session from BetterAuth.
 *
 * Tokens are stored as `enc:v1:<base64-ciphertext>`. Plain tokens (legacy)
 * are passed through unchanged. This is a pure function and is exported for
 * unit testing.
 */
export async function loadAndDecryptSession(
  encryptedAccessToken: string,
  encryptedIdToken: string | undefined,
  sessionSecret: string
): Promise<VrchatSessionTokens> {
  const authToken = encryptedAccessToken.startsWith(ENCRYPTED_PREFIX)
    ? await decryptForPurpose(
        encryptedAccessToken.slice(ENCRYPTED_PREFIX.length),
        sessionSecret,
        PROVIDER_SESSION_PURPOSE
      )
    : encryptedAccessToken;

  let twoFactorAuthToken: string | undefined;
  if (encryptedIdToken) {
    const decrypted = encryptedIdToken.startsWith(ENCRYPTED_PREFIX)
      ? await decryptForPurpose(
          encryptedIdToken.slice(ENCRYPTED_PREFIX.length),
          sessionSecret,
          PROVIDER_SESSION_PURPOSE
        )
      : encryptedIdToken;
    twoFactorAuthToken = decrypted || undefined;
  }

  return { authToken, twoFactorAuthToken };
}

/**
 * Resolves a VRChat avatar display name by ID.
 *
 * Uses a live buyer session stored in BetterAuth (Node.js runtime required for
 * HKDF decryption). Session tokens never leave Convex — only the avatar name
 * is returned to callers.
 */
export const resolveAvatarName = internalAction({
  args: {
    authUserId: v.string(),
    avatarId: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const sessionSecret =
      process.env.VRCHAT_PROVIDER_SESSION_SECRET ?? process.env.BETTER_AUTH_SECRET;
    if (!sessionSecret) {
      console.error('[vrchat/resolveAvatarName] missing VRCHAT_PROVIDER_SESSION_SECRET');
      return '';
    }

    const providerUserIds: string[] = await ctx.runQuery(
      internal.yucpLicenses.getVrchatProviderUserIdsForCreator,
      { authUserId: args.authUserId }
    );

    if (!providerUserIds.length) {
      console.log('[vrchat/resolveAvatarName] no VRChat buyers linked to creator', {
        authUserId: args.authUserId,
      });
      return '';
    }

    const client = new VrchatWebClient();

    for (const providerUserId of providerUserIds) {
      const account = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: 'account',
        where: [
          { field: 'accountId', value: providerUserId },
          { field: 'providerId', value: 'vrchat' },
        ],
        select: ['accessToken', 'idToken'],
      })) as { accessToken?: string; idToken?: string } | null;

      if (!account?.accessToken) continue;

      try {
        const session = await loadAndDecryptSession(
          account.accessToken,
          account.idToken || undefined,
          sessionSecret
        );
        const name = await client.getAvatarById(session, args.avatarId);
        if (name) {
          console.log('[vrchat/resolveAvatarName] resolved', {
            avatarId: args.avatarId,
            name,
          });
          return name;
        }
      } catch (err) {
        console.warn('[vrchat/resolveAvatarName] session failed, trying next buyer', {
          providerUserId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    console.log('[vrchat/resolveAvatarName] no buyer session could resolve avatar', {
      authUserId: args.authUserId,
      avatarId: args.avatarId,
    });
    return '';
  },
});
