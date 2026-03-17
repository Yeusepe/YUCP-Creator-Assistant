/**
 * BetterAuth Plugin: stores encrypted VRChat provider sessions and issues
 * BetterAuth sessions. Outbound VRChat API calls are handled by Bun.
 */

import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import {
  canonicalizeJson,
  constantTimeEqual,
  decryptForPurpose,
  encryptForPurpose,
  sha256Base64,
  signValue,
} from '../lib/vrchat/crypto';

const INTERNAL_AUTH_TS_HEADER = 'x-yucp-internal-auth-ts';
const INTERNAL_AUTH_SIG_HEADER = 'x-yucp-internal-auth-sig';
const INTERNAL_AUTH_MAX_AGE_MS = 5 * 60 * 1000;
const PROVIDER_SESSION_PURPOSE = 'vrchat-provider-session';
const ENCRYPTED_TOKEN_PREFIX = 'enc:v1:';

interface VrchatCurrentUser {
  id: string;
  displayName?: string;
  username?: string;
}

interface VrchatSessionTokens {
  authToken: string;
  twoFactorAuthToken?: string;
}

function getSecret(name: string): string {
  const value = process.env[name];
  if (value) {
    return value;
  }

  if (process.env.NODE_ENV !== 'production' && process.env.BETTER_AUTH_SECRET) {
    return process.env.BETTER_AUTH_SECRET;
  }

  throw new APIError('INTERNAL_SERVER_ERROR', {
    message: 'Authentication is not configured',
  });
}

function getInternalAuthSecret(): string {
  return getSecret('INTERNAL_SERVICE_AUTH_SECRET');
}

function getProviderSessionSecret(): string {
  return getSecret('VRCHAT_PROVIDER_SESSION_SECRET');
}

async function assertInternalAuth(ctx: any): Promise<void> {
  const request = ctx.request as Request;
  const tsHeader = request.headers.get(INTERNAL_AUTH_TS_HEADER) ?? '';
  const sigHeader = request.headers.get(INTERNAL_AUTH_SIG_HEADER) ?? '';

  if (!tsHeader || !sigHeader) {
    throw new APIError('UNAUTHORIZED', { message: 'Unauthorized' });
  }

  const timestamp = Number(tsHeader);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > INTERNAL_AUTH_MAX_AGE_MS) {
    throw new APIError('UNAUTHORIZED', { message: 'Unauthorized' });
  }

  const pathname = new URL(request.url).pathname;
  const bodyHash = await sha256Base64(canonicalizeJson(ctx.body));
  const payload = `${tsHeader}.${request.method.toUpperCase()}.${pathname}.${bodyHash}`;
  const expectedSignature = await signValue(getInternalAuthSecret(), payload);

  if (!constantTimeEqual(expectedSignature, sigHeader)) {
    throw new APIError('UNAUTHORIZED', { message: 'Unauthorized' });
  }
}

async function encryptStoredToken(value: string): Promise<string> {
  return `${ENCRYPTED_TOKEN_PREFIX}${await encryptForPurpose(
    value,
    getProviderSessionSecret(),
    PROVIDER_SESSION_PURPOSE
  )}`;
}

async function maybeDecryptStoredToken(
  value: unknown
): Promise<{ token?: string; legacy: boolean }> {
  if (typeof value !== 'string' || !value) {
    return { token: undefined, legacy: false };
  }

  if (!value.startsWith(ENCRYPTED_TOKEN_PREFIX)) {
    return { token: value, legacy: true };
  }

  const ciphertext = value.slice(ENCRYPTED_TOKEN_PREFIX.length);
  try {
    return {
      token: await decryptForPurpose(
        ciphertext,
        getProviderSessionSecret(),
        PROVIDER_SESSION_PURPOSE
      ),
      legacy: false,
    };
  } catch {
    throw new APIError('UNAUTHORIZED', { message: 'Stored VRChat session is invalid' });
  }
}

async function serializeStoredSession(
  session: VrchatSessionTokens
): Promise<{ accessToken: string; idToken: string }> {
  return {
    accessToken: await encryptStoredToken(session.authToken),
    idToken: session.twoFactorAuthToken ? await encryptStoredToken(session.twoFactorAuthToken) : '',
  };
}

async function loadStoredSession(account: any): Promise<{
  session: VrchatSessionTokens | null;
  legacy: boolean;
}> {
  const auth = await maybeDecryptStoredToken(account?.accessToken);
  if (!auth.token) {
    return { session: null, legacy: false };
  }

  const secondFactor = await maybeDecryptStoredToken(account?.idToken);
  return {
    session: {
      authToken: auth.token,
      twoFactorAuthToken: secondFactor.token,
    },
    legacy: auth.legacy || secondFactor.legacy,
  };
}

function parseVrchatUser(value: unknown): VrchatCurrentUser {
  if (!value || typeof value !== 'object') {
    throw new APIError('BAD_REQUEST', { message: 'vrchatUser is required' });
  }

  const user = value as Record<string, unknown>;
  if (typeof user.id !== 'string' || !user.id.trim()) {
    throw new APIError('BAD_REQUEST', { message: 'vrchatUser.id is required' });
  }

  return {
    id: user.id,
    displayName: typeof user.displayName === 'string' ? user.displayName : undefined,
    username: typeof user.username === 'string' ? user.username : undefined,
  };
}

function parseProviderSession(body: Record<string, unknown>): VrchatSessionTokens {
  if (typeof body.authToken !== 'string' || !body.authToken) {
    throw new APIError('BAD_REQUEST', { message: 'authToken is required' });
  }

  return {
    authToken: body.authToken,
    twoFactorAuthToken:
      typeof body.twoFactorAuthToken === 'string' && body.twoFactorAuthToken
        ? body.twoFactorAuthToken
        : undefined,
  };
}

async function createVrchatSession(
  ctx: any,
  vrchatUser: VrchatCurrentUser,
  providerSession: VrchatSessionTokens
) {
  const vrchatUserId = vrchatUser.id;
  const displayName = vrchatUser.displayName || vrchatUser.username || vrchatUserId;
  const email = `${vrchatUserId}@vrchat.invalid`;
  const encryptedSession = await serializeStoredSession(providerSession);
  const existing = await ctx.context.internalAdapter.findOAuthUser(email, vrchatUserId, 'vrchat');

  let user: any;
  if (existing) {
    user = existing.user;
    const account = existing.accounts.find((entry: any) => entry.providerId === 'vrchat');
    if (account) {
      await ctx.context.internalAdapter.updateAccount(account.id, {
        accessToken: encryptedSession.accessToken,
        idToken: encryptedSession.idToken,
      });
    }
  } else {
    const created = await ctx.context.internalAdapter.createOAuthUser(
      { name: displayName, email, emailVerified: false },
      {
        providerId: 'vrchat',
        accountId: vrchatUserId,
        accessToken: encryptedSession.accessToken,
        idToken: encryptedSession.idToken || undefined,
      }
    );
    user = created.user;
  }

  const session = await ctx.context.internalAdapter.createSession(user.id);
  await setSessionCookie(ctx, { session, user });

  return ctx.json({ userId: user.id, vrchatUserId, displayName });
}

async function rewriteLegacySessionIfNeeded(
  ctx: any,
  accountId: string,
  session: VrchatSessionTokens,
  legacy: boolean
): Promise<void> {
  if (!legacy) return;
  const encryptedSession = await serializeStoredSession(session);
  await ctx.context.internalAdapter.updateAccount(accountId, {
    accessToken: encryptedSession.accessToken,
    idToken: encryptedSession.idToken,
  });
}

export const vrchat = (): BetterAuthPlugin => ({
  id: 'vrchat',
  endpoints: {
    signInVrchatSession: createAuthEndpoint(
      '/sign-in/vrchat/session',
      { method: 'POST' },
      async (ctx) => {
        await assertInternalAuth(ctx);
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const vrchatUser = parseVrchatUser(body.vrchatUser);
        const providerSession = parseProviderSession(body);
        return createVrchatSession(ctx, vrchatUser, providerSession);
      }
    ),

    vrchatSessionTokens: createAuthEndpoint(
      '/vrchat/session-tokens',
      {
        method: 'GET',
        use: [sessionMiddleware],
      },
      async (ctx) => {
        await assertInternalAuth(ctx);
        const userId = ctx.context.session.user.id;
        const accounts = await ctx.context.internalAdapter.findAccounts(userId);
        const vrchatAccount = accounts.find((entry: any) => entry.providerId === 'vrchat');

        if (!vrchatAccount?.accessToken) {
          return new Response(JSON.stringify({ needsLink: true }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }

        let loaded: Awaited<ReturnType<typeof loadStoredSession>> | undefined;
        try {
          loaded = await loadStoredSession(vrchatAccount);
        } catch {
          return new Response(JSON.stringify({ sessionExpired: true }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        }

        const { session, legacy } = loaded;
        if (!session) {
          return new Response(JSON.stringify({ needsLink: true }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }

        await rewriteLegacySessionIfNeeded(ctx, vrchatAccount.id, session, legacy);

        return ctx.json({
          authToken: session.authToken,
          twoFactorAuthToken: session.twoFactorAuthToken,
        });
      }
    ),

    vrchatSessionClear: createAuthEndpoint(
      '/vrchat/session-clear',
      {
        method: 'POST',
        use: [sessionMiddleware],
      },
      async (ctx) => {
        await assertInternalAuth(ctx);
        const userId = ctx.context.session.user.id;
        const accounts = await ctx.context.internalAdapter.findAccounts(userId);
        const vrchatAccount = accounts.find((entry: any) => entry.providerId === 'vrchat');
        console.log('VRChat session clear', {
          userId,
          hadLinkedAccount: Boolean(vrchatAccount),
        });

        if (vrchatAccount) {
          await ctx.context.internalAdapter.updateAccount(vrchatAccount.id, {
            accessToken: '',
            idToken: '',
          });
        }

        return ctx.json({ success: true });
      }
    ),

    vrchatSessionClearProvider: createAuthEndpoint(
      '/vrchat/session-clear-provider',
      {
        method: 'POST',
      },
      async (ctx) => {
        await assertInternalAuth(ctx);
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const vrchatUser = parseVrchatUser(body.vrchatUser);
        const email = `${vrchatUser.id}@vrchat.invalid`;
        const existing = await ctx.context.internalAdapter.findOAuthUser(
          email,
          vrchatUser.id,
          'vrchat'
        );
        const account = existing?.accounts.find((entry: any) => entry.providerId === 'vrchat');

        console.log('VRChat session clear provider', {
          vrchatUserId: vrchatUser.id,
          hadLinkedAccount: Boolean(account),
        });

        if (account) {
          await ctx.context.internalAdapter.updateAccount(account.id, {
            accessToken: '',
            idToken: '',
          });
        }

        return ctx.json({ success: true });
      }
    ),
  },
});
