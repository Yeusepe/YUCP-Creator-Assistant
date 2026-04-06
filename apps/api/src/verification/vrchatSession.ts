/**
 * Focused VRChat verification session helpers.
 *
 * Keeps Better Auth persistence, stored-session lookup, and ownership helpers
 * isolated from the larger verification route orchestration.
 */

import { type TwoFactorAuthType, type VrchatCurrentUser } from '@yucp/providers';
import type { VrchatSessionTokens } from '@yucp/providers/vrchat';
import { api } from '../../../../convex/_generated/api';
import type {
  VrchatInternalResponse,
  VrchatOwnershipPayload,
  VrchatSessionTokensPayload,
  VrchatSessionUserPayload,
} from '../auth';
import { getConvexClientFromUrl } from '../lib/convex';
import { logger } from '../lib/logger';

export type BetterAuthVrchatSessionResult =
  | {
      success: true;
      browserSetCookies: string[];
      betterAuthCookieHeader: string;
    }
  | {
      success: false;
      error: string;
      status: number;
      browserSetCookies: string[];
      betterAuthCookieHeader: string;
    };

export type StoredVrchatSessionResult =
  | {
      success: true;
      session: VrchatSessionTokensPayload;
    }
  | {
      success: false;
      error: string;
      status: number;
      needsCredentials?: boolean;
    };

export interface VrchatSessionAuthClient {
  persistVrchatSession(
    vrchatUser: VrchatSessionUserPayload,
    session: VrchatSessionTokensPayload,
    requestCookieHeader?: string
  ): Promise<VrchatInternalResponse>;
  getVrchatSessionTokens(
    betterAuthCookieHeader: string,
    requestCookieHeader?: string
  ): Promise<VrchatInternalResponse>;
  clearVrchatSession(
    betterAuthCookieHeader: string,
    requestCookieHeader?: string
  ): Promise<VrchatInternalResponse>;
}

export interface VrchatOwnershipLookupClient {
  getOwnershipFromSession(session: VrchatSessionTokens): Promise<{
    vrchatUserId: string;
    displayName: string;
    ownedAvatarIds: string[];
  } | null>;
}

export interface VrchatSubjectLookupConfig {
  convexUrl: string;
  convexApiSecret: string;
}

export interface VrchatSubjectLookupClient {
  mutation(
    reference: unknown,
    args: {
      apiSecret: string;
      discordUserId: string;
      displayName: undefined;
      avatarUrl: undefined;
    }
  ): Promise<{ subjectId: string }>;
}

export function parseTwoFactorType(type: string | undefined): TwoFactorAuthType | undefined {
  if (type === 'totp' || type === 'emailOtp' || type === 'otp') {
    return type;
  }
  return undefined;
}

export function buildSessionFromAuthResult(result: {
  browserSetCookies: string[];
  betterAuthCookieHeader: string;
}): BetterAuthVrchatSessionResult {
  const { browserSetCookies, betterAuthCookieHeader } = result;
  if (!betterAuthCookieHeader) {
    return {
      success: false,
      status: 500,
      error: 'Verification succeeded, but the account session could not be established.',
      browserSetCookies,
      betterAuthCookieHeader,
    };
  }

  return {
    success: true,
    browserSetCookies,
    betterAuthCookieHeader,
  };
}

export async function persistVrchatSession(
  betterAuth: VrchatSessionAuthClient,
  requestCookieHeader: string,
  vrchatUser: VrchatCurrentUser,
  session: VrchatSessionTokens
): Promise<BetterAuthVrchatSessionResult> {
  const persistResult = await betterAuth.persistVrchatSession(
    {
      id: vrchatUser.id,
      displayName: vrchatUser.displayName,
      username: vrchatUser.username,
    },
    {
      authToken: session.authToken,
      twoFactorAuthToken: session.twoFactorAuthToken,
    },
    requestCookieHeader
  );
  if (!persistResult.response.ok) {
    const persistBody = await persistResult.response
      .clone()
      .text()
      .catch(() => '');
    logger.warn('VRChat verify: persist session failed', {
      status: persistResult.response.status,
      bodyPreview: persistBody.slice(0, 500),
      setCookieCount: persistResult.browserSetCookies.length,
    });
    return {
      success: false,
      status: persistResult.response.status,
      error: 'Verification succeeded, but the account session could not be established.',
      browserSetCookies: persistResult.browserSetCookies,
      betterAuthCookieHeader: persistResult.betterAuthCookieHeader,
    };
  }

  return buildSessionFromAuthResult(persistResult);
}

export async function getStoredVrchatSession(
  betterAuth: VrchatSessionAuthClient,
  requestCookieHeader: string,
  betterAuthCookieHeader: string
): Promise<StoredVrchatSessionResult> {
  const { response } = await betterAuth.getVrchatSessionTokens(
    betterAuthCookieHeader,
    requestCookieHeader
  );
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (response.ok) {
    if (typeof payload.authToken === 'string' && payload.authToken) {
      return {
        success: true,
        session: {
          authToken: payload.authToken,
          twoFactorAuthToken:
            typeof payload.twoFactorAuthToken === 'string' && payload.twoFactorAuthToken
              ? payload.twoFactorAuthToken
              : undefined,
        },
      };
    }

    return {
      success: false,
      status: 500,
      error: 'Stored VRChat session is invalid.',
    };
  }

  if (response.status === 404 && payload.needsLink) {
    return {
      success: false,
      status: 404,
      needsCredentials: true,
      error: 'Please enter your VRChat username and password to verify.',
    };
  }

  if (response.status === 401) {
    return {
      success: false,
      status: 401,
      needsCredentials: true,
      error: 'Please enter your VRChat username and password to verify.',
    };
  }

  return {
    success: false,
    status: response.status,
    error: 'Verification failed. Please try again.',
  };
}

export async function clearStoredVrchatSession(
  betterAuth: VrchatSessionAuthClient,
  requestCookieHeader: string,
  betterAuthCookieHeader: string
): Promise<void> {
  try {
    await betterAuth.clearVrchatSession(betterAuthCookieHeader, requestCookieHeader);
  } catch {
    // Best-effort cleanup only.
  }
}

export async function getOwnershipFromSession(
  client: VrchatOwnershipLookupClient,
  session: VrchatSessionTokens
): Promise<VrchatOwnershipPayload | null> {
  let ownership = null;
  try {
    ownership = await client.getOwnershipFromSession(session);
  } catch {
    return null;
  }
  if (!ownership) {
    return null;
  }

  return {
    vrchatUserId: ownership.vrchatUserId,
    displayName: ownership.displayName,
    ownedAvatarIds: ownership.ownedAvatarIds,
  };
}

export async function ensureVrchatSubjectId(
  discordUserId: string,
  config: VrchatSubjectLookupConfig,
  getConvexClient: (url: string) => VrchatSubjectLookupClient = getConvexClientFromUrl as (
    url: string
  ) => VrchatSubjectLookupClient
): Promise<string> {
  const convex = getConvexClient(config.convexUrl);
  const ensureResult = await convex.mutation(api.subjects.ensureSubjectForDiscord, {
    apiSecret: config.convexApiSecret,
    discordUserId,
    displayName: undefined,
    avatarUrl: undefined,
  });
  return ensureResult.subjectId;
}
