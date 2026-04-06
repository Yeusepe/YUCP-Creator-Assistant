import { VrchatApiClient } from '@yucp/providers';
import type { StructuredLogger } from '@yucp/shared';
import { createAuth, type VrchatOwnershipPayload } from '../auth';
import type { StateStore } from '../lib/stateStore';
import { getStateStore } from '../lib/stateStore';
import type { VerificationConfig } from './verificationConfig';
import {
  isAllowedVrchatOrigin,
  isVrchatRateLimited,
  jsonNoStore,
  withNoStore,
  withSetCookies,
} from './verificationRouteSupport';
import { generateSecureRandom } from './verificationSessionPrimitives';
import {
  clearPendingVrchatState,
  createPendingVrchatState,
  readPendingVrchatState,
} from './vrchatPending';
import {
  clearStoredVrchatSession,
  ensureVrchatSubjectId,
  getOwnershipFromSession,
  getStoredVrchatSession,
  parseTwoFactorType,
  persistVrchatSession,
  type VrchatSessionAuthClient,
} from './vrchatSession';

const VRCHAT_TOKEN_PREFIX = 'vrchat_verify:';
const VRCHAT_TOKEN_TTL_MS = 15 * 60 * 1000;

const VRCHAT_INVALID_LINK_ERROR =
  'Invalid or expired link. Please use the Verify with VRChat button in Discord.';
const VRCHAT_GENERIC_FAILURE = 'Verification failed. Please check your credentials and try again.';

interface CreateVrchatVerificationRouteHandlersOptions {
  config: VerificationConfig;
  logger: StructuredLogger;
  deps?: Partial<{
    createAuth: (config: Parameters<typeof createAuth>[0]) => VrchatSessionAuthClient;
    getStateStore: typeof getStateStore;
  }>;
}

interface BeginVrchatVerificationInput {
  authUserId: string;
  discordUserId?: string;
  redirectUri: string;
}

interface VrchatVerificationTokenPayload {
  authUserId: string;
  discordUserId: string;
  redirectUri?: string;
}

interface VrchatVerifyRequestBody {
  token?: string;
  username?: string;
  password?: string;
  twoFactorCode?: string;
  pendingToken?: string;
  type?: string;
}

interface FinalizeOwnershipContext {
  authUserId: string;
  config: VerificationConfig;
  discordUserId: string;
  headers?: Headers;
  logger: StructuredLogger;
  ownership: VrchatOwnershipPayload;
  redirectUri?: string;
  store: StateStore;
  token: string;
}

async function loadVrchatVerificationPayload(
  store: StateStore,
  token: string
): Promise<
  | {
      success: true;
      payload: VrchatVerificationTokenPayload;
    }
  | {
      success: false;
      response: Response;
    }
> {
  const raw = await store.get(`${VRCHAT_TOKEN_PREFIX}${token}`);
  if (!raw) {
    return {
      success: false,
      response: jsonNoStore(
        {
          success: false,
          error: VRCHAT_INVALID_LINK_ERROR,
        },
        { status: 400 }
      ),
    };
  }

  try {
    return {
      success: true,
      payload: JSON.parse(raw) as VrchatVerificationTokenPayload,
    };
  } catch {
    await store.delete(`${VRCHAT_TOKEN_PREFIX}${token}`);
    return {
      success: false,
      response: jsonNoStore(
        { success: false, error: 'Invalid token. Please try again from Discord.' },
        { status: 400 }
      ),
    };
  }
}

async function finalizeVrchatOwnership({
  authUserId,
  config,
  discordUserId,
  headers,
  logger,
  ownership,
  redirectUri,
  store,
  token,
}: FinalizeOwnershipContext): Promise<Response> {
  let subjectId: string;
  try {
    subjectId = await ensureVrchatSubjectId(discordUserId, {
      convexUrl: config.convexUrl,
      convexApiSecret: config.convexApiSecret,
    });
  } catch (err) {
    logger.error('VRChat verify: ensureSubjectForDiscord failed', {
      error: err instanceof Error ? err.message : String(err),
      authUserId,
    });
    return jsonNoStore(
      {
        success: false,
        error: 'Failed to look up your account. Please try again.',
      },
      {
        status: 500,
        headers: headers ?? withNoStore({ 'Content-Type': 'application/json' }),
      }
    );
  }

  const { handleCompleteVrchat } = await import('./completeVrchat');
  const result = await handleCompleteVrchat(config, {
    authUserId,
    subjectId,
    vrchatUserId: ownership.vrchatUserId,
    displayName: ownership.displayName,
    ownedAvatarIds: ownership.ownedAvatarIds,
  });

  if (!result.success) {
    return jsonNoStore(
      {
        success: false,
        error: result.error ?? 'Verification failed.',
      },
      {
        status: 400,
        headers: headers ?? withNoStore({ 'Content-Type': 'application/json' }),
      }
    );
  }

  await store.delete(`${VRCHAT_TOKEN_PREFIX}${token}`);
  return jsonNoStore(
    {
      success: true,
      entitlementIds: result.entitlementIds,
      redirectUri,
    },
    {
      status: 200,
      headers: headers ?? withNoStore({ 'Content-Type': 'application/json' }),
    }
  );
}

interface SharedVrchatVerificationContext {
  betterAuth: VrchatSessionAuthClient;
  betterAuthCookieHeader: string;
  client: VrchatApiClient;
  config: VerificationConfig;
  discordUserId: string;
  logger: StructuredLogger;
  payload: VrchatVerificationTokenPayload;
  request: Request;
  requestCookieHeader: string;
  store: StateStore;
  token: string;
  tokenSuffix: string;
}

async function handleVrchatTwoFactorStep(
  context: SharedVrchatVerificationContext,
  twoFactorCode: string,
  twoFactorType: ReturnType<typeof parseTwoFactorType>
): Promise<Response> {
  const {
    betterAuth,
    client,
    payload,
    request,
    requestCookieHeader,
    store,
    token,
    tokenSuffix,
    config,
    discordUserId,
    logger,
  } = context;

  const responseHeaders = withNoStore({ 'Content-Type': 'application/json' });
  const pending = await readPendingVrchatState(store, request, token);
  if (!pending) {
    logger.warn('VRChat verify 2FA: pending state missing', { tokenSuffix });
    await clearPendingVrchatState(store, request, responseHeaders);
    return jsonNoStore(
      {
        success: false,
        needsCredentials: true,
        error: 'Two-factor authentication has expired. Please sign in again.',
      },
      { status: 401, headers: responseHeaders }
    );
  }

  try {
    logger.info('VRChat verify 2FA: attempting completion', {
      tokenSuffix,
      requestedType: twoFactorType ?? null,
      allowedTypes: pending.state.types,
    });
    const completed = await client.completePendingLogin(
      pending.state.pendingState,
      twoFactorCode,
      twoFactorType
    );
    const ownership = await getOwnershipFromSession(client, completed.session);
    if (!ownership) {
      throw new Error('Verification failed');
    }

    const sessionResult = await persistVrchatSession(
      betterAuth,
      requestCookieHeader,
      completed.user,
      completed.session
    );
    logger.info('VRChat verify 2FA: persist result', {
      tokenSuffix,
      success: sessionResult.success,
      status: sessionResult.success ? 200 : sessionResult.status,
      setCookieCount: sessionResult.browserSetCookies.length,
    });
    withSetCookies(responseHeaders, sessionResult.browserSetCookies);
    await clearPendingVrchatState(store, request, responseHeaders);

    if (!sessionResult.success) {
      return jsonNoStore(
        { success: false, error: sessionResult.error },
        { status: sessionResult.status, headers: responseHeaders }
      );
    }

    return finalizeVrchatOwnership({
      authUserId: payload.authUserId,
      config,
      discordUserId,
      headers: responseHeaders,
      logger,
      ownership,
      redirectUri: payload.redirectUri,
      store,
      token,
    });
  } catch (error) {
    logger.warn('VRChat verify 2FA failed', {
      tokenSuffix,
      error: error instanceof Error ? error.message : String(error),
    });
    await clearPendingVrchatState(store, request, responseHeaders);
    return jsonNoStore(
      {
        success: false,
        error: VRCHAT_GENERIC_FAILURE,
      },
      { status: 401, headers: responseHeaders }
    );
  }
}

async function handleVrchatPasswordStep(
  context: SharedVrchatVerificationContext,
  username: string,
  password: string,
  twoFactorCode: string | undefined,
  twoFactorType: ReturnType<typeof parseTwoFactorType>
): Promise<Response> {
  const {
    betterAuth,
    client,
    payload,
    request,
    requestCookieHeader,
    store,
    token,
    tokenSuffix,
    config,
    discordUserId,
    logger,
  } = context;

  const responseHeaders = withNoStore({ 'Content-Type': 'application/json' });
  let initial: Awaited<ReturnType<VrchatApiClient['beginLogin']>>;
  try {
    initial = await client.beginLogin(username, password);
    logger.info('VRChat verify password step: beginLogin result', {
      tokenSuffix,
      success: initial.success,
      requiresTwoFactorAuth: initial.success ? [] : initial.requiresTwoFactorAuth,
    });
  } catch (error) {
    logger.warn('VRChat verify password step: beginLogin failed', {
      tokenSuffix,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonNoStore(
      {
        success: false,
        error: VRCHAT_GENERIC_FAILURE,
      },
      { status: 401, headers: responseHeaders }
    );
  }

  if (!initial.success) {
    if (twoFactorCode) {
      try {
        logger.info('VRChat verify password step: stale-client inline 2FA', {
          tokenSuffix,
          requestedType: twoFactorType ?? null,
        });
        const completed = await client.completePendingLogin(
          initial.pendingState,
          twoFactorCode,
          twoFactorType
        );
        const ownership = await getOwnershipFromSession(client, completed.session);
        if (!ownership) {
          throw new Error('Verification failed');
        }

        const sessionResult = await persistVrchatSession(
          betterAuth,
          requestCookieHeader,
          completed.user,
          completed.session
        );
        logger.info('VRChat verify password step: stale-client persist result', {
          tokenSuffix,
          success: sessionResult.success,
          status: sessionResult.success ? 200 : sessionResult.status,
          setCookieCount: sessionResult.browserSetCookies.length,
        });
        withSetCookies(responseHeaders, sessionResult.browserSetCookies);
        if (!sessionResult.success) {
          return jsonNoStore(
            { success: false, error: sessionResult.error },
            { status: sessionResult.status, headers: responseHeaders }
          );
        }

        return finalizeVrchatOwnership({
          authUserId: payload.authUserId,
          config,
          discordUserId,
          headers: responseHeaders,
          logger,
          ownership,
          redirectUri: payload.redirectUri,
          store,
          token,
        });
      } catch (error) {
        logger.warn('VRChat verify password step: stale-client inline 2FA failed', {
          tokenSuffix,
          error: error instanceof Error ? error.message : String(error),
        });
        return jsonNoStore(
          {
            success: false,
            error: VRCHAT_GENERIC_FAILURE,
          },
          { status: 401, headers: responseHeaders }
        );
      }
    }

    logger.info('VRChat verify password step: creating pending 2FA state', {
      tokenSuffix,
      types: initial.requiresTwoFactorAuth,
    });
    responseHeaders.append(
      'Set-Cookie',
      await createPendingVrchatState(store, request, {
        verificationToken: token,
        pendingState: initial.pendingState,
        types: initial.requiresTwoFactorAuth,
      })
    );
    return jsonNoStore(
      {
        success: false,
        error: 'Two-factor authentication is required. Enter your code and try again.',
        twoFactorRequired: true,
        types: initial.requiresTwoFactorAuth,
      },
      { status: 200, headers: responseHeaders }
    );
  }

  const ownership = await getOwnershipFromSession(client, initial.session);
  if (!ownership) {
    return jsonNoStore(
      {
        success: false,
        error: VRCHAT_GENERIC_FAILURE,
      },
      { status: 401, headers: responseHeaders }
    );
  }

  const sessionResult = await persistVrchatSession(
    betterAuth,
    requestCookieHeader,
    initial.user,
    initial.session
  );
  logger.info('VRChat verify password step: persist result', {
    tokenSuffix,
    success: sessionResult.success,
    status: sessionResult.success ? 200 : sessionResult.status,
    setCookieCount: sessionResult.browserSetCookies.length,
  });
  withSetCookies(responseHeaders, sessionResult.browserSetCookies);

  if (!sessionResult.success) {
    return jsonNoStore(
      { success: false, error: sessionResult.error },
      { status: sessionResult.status, headers: responseHeaders }
    );
  }

  return finalizeVrchatOwnership({
    authUserId: payload.authUserId,
    config,
    discordUserId,
    headers: responseHeaders,
    logger,
    ownership,
    redirectUri: payload.redirectUri,
    store,
    token,
  });
}

async function handleStoredVrchatSessionStep(
  context: SharedVrchatVerificationContext
): Promise<Response> {
  const {
    betterAuth,
    betterAuthCookieHeader,
    client,
    payload,
    requestCookieHeader,
    store,
    token,
    tokenSuffix,
    config,
    discordUserId,
    logger,
  } = context;

  const storedSessionResult = await getStoredVrchatSession(
    betterAuth,
    requestCookieHeader,
    betterAuthCookieHeader
  );
  logger.info('VRChat verify auto step: stored session lookup result', {
    tokenSuffix,
    success: storedSessionResult.success,
    status: storedSessionResult.success ? 200 : storedSessionResult.status,
    needsCredentials: storedSessionResult.success
      ? false
      : (storedSessionResult.needsCredentials ?? false),
  });
  if (!storedSessionResult.success) {
    return jsonNoStore(
      {
        success: false,
        error: storedSessionResult.error,
        needsCredentials: storedSessionResult.needsCredentials,
      },
      { status: storedSessionResult.status }
    );
  }

  const ownership = await getOwnershipFromSession(client, storedSessionResult.session);
  if (!ownership) {
    logger.warn('VRChat verify auto step: stored session unusable, clearing', {
      tokenSuffix,
    });
    await clearStoredVrchatSession(betterAuth, requestCookieHeader, betterAuthCookieHeader);
    return jsonNoStore(
      {
        success: false,
        error: 'Your VRChat session has expired. Please enter your credentials to re-verify.',
        needsCredentials: true,
        sessionExpired: true,
      },
      { status: 401 }
    );
  }

  return finalizeVrchatOwnership({
    authUserId: payload.authUserId,
    config,
    discordUserId,
    logger,
    ownership,
    redirectUri: payload.redirectUri,
    store,
    token,
  });
}

export function createVrchatVerificationRouteHandlers({
  config,
  logger,
  deps: injectedDeps,
}: CreateVrchatVerificationRouteHandlersOptions) {
  const deps = {
    createAuth,
    getStateStore,
    ...injectedDeps,
  };

  async function beginVrchatVerification({
    authUserId,
    discordUserId,
    redirectUri,
  }: BeginVrchatVerificationInput): Promise<Response> {
    if (!discordUserId) {
      return Response.json(
        { success: false, error: 'discordUserId is required for VRChat verification' },
        { status: 400 }
      );
    }

    const token = generateSecureRandom(32);
    const store = deps.getStateStore();
    await store.set(
      `${VRCHAT_TOKEN_PREFIX}${token}`,
      JSON.stringify({
        authUserId,
        discordUserId,
        redirectUri,
      } satisfies VrchatVerificationTokenPayload),
      VRCHAT_TOKEN_TTL_MS
    );
    const vrchatUrl = `${config.baseUrl}/vrchat-verify?token=${encodeURIComponent(token)}`;
    return Response.redirect(vrchatUrl, 302);
  }

  async function completeVrchatVerification(_request: Request): Promise<Response> {
    return Response.json(
      {
        success: false,
        error: 'Use /api/verification/vrchat-verify for VRChat verification.',
      },
      { status: 410 }
    );
  }

  async function vrchatVerify(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return jsonNoStore({ error: 'Method not allowed' }, { status: 405 });
    }

    let body: VrchatVerifyRequestBody;
    try {
      body = (await request.json()) as VrchatVerifyRequestBody;
    } catch {
      return jsonNoStore({ success: false, error: 'Invalid JSON' }, { status: 400 });
    }

    const token = body.token?.trim();
    const username = body.username?.trim() || undefined;
    const password = body.password || undefined;
    const twoFactorCode = body.twoFactorCode?.trim() || undefined;
    const pendingToken = body.pendingToken?.trim() || undefined;
    const twoFactorType = parseTwoFactorType(body.type?.trim());

    if (!isAllowedVrchatOrigin(request, config)) {
      return jsonNoStore({ success: false, error: 'Invalid request origin.' }, { status: 403 });
    }

    if (!token) {
      return jsonNoStore(
        {
          success: false,
          error: VRCHAT_INVALID_LINK_ERROR,
        },
        { status: 400 }
      );
    }

    if ((username && !password) || (!username && password)) {
      return jsonNoStore(
        {
          success: false,
          error: 'Please provide both your VRChat username and password.',
        },
        { status: 400 }
      );
    }

    if ((username && password) || twoFactorCode) {
      if (isVrchatRateLimited(token, request)) {
        return jsonNoStore(
          {
            success: false,
            error: 'Too many verification attempts. Please wait a few minutes and try again.',
          },
          { status: 429 }
        );
      }
    }

    const store = deps.getStateStore();
    const payloadResult = await loadVrchatVerificationPayload(store, token);
    if (!payloadResult.success) {
      return payloadResult.response;
    }

    const payload = payloadResult.payload;
    const { authUserId, discordUserId } = payload;
    const convexSiteUrl = config.convexUrl
      ? config.convexUrl.replace('.convex.cloud', '.convex.site')
      : '';
    const requestCookieHeader = request.headers.get('cookie') ?? '';
    const betterAuthCookieHeader =
      request.headers.get('better-auth-cookie')?.trim() || requestCookieHeader;
    const betterAuth = deps.createAuth({
      baseUrl: config.baseUrl,
      convexSiteUrl,
      convexUrl: config.convexUrl,
    });
    const client = new VrchatApiClient();
    const tokenSuffix = token.slice(-8);

    logger.info('VRChat verify request', {
      tokenSuffix,
      hasUsername: Boolean(username),
      hasPassword: Boolean(password),
      hasTwoFactorCode: Boolean(twoFactorCode),
      hasPendingToken: Boolean(pendingToken),
      cookieLength: requestCookieHeader.length,
      origin: request.headers.get('origin'),
    });

    try {
      if (!convexSiteUrl) {
        return jsonNoStore(
          { success: false, error: 'VRChat authentication is not configured.' },
          { status: 500 }
        );
      }

      const context: SharedVrchatVerificationContext = {
        betterAuth,
        betterAuthCookieHeader,
        client,
        config,
        discordUserId,
        logger,
        payload,
        request,
        requestCookieHeader,
        store,
        token,
        tokenSuffix,
      };

      if (pendingToken || (!username && !password && twoFactorCode)) {
        if (!twoFactorCode) {
          return jsonNoStore(
            { success: false, error: 'Two-factor authentication code is required.' },
            { status: 400 }
          );
        }

        return await handleVrchatTwoFactorStep(context, twoFactorCode, twoFactorType);
      }

      if (username && password) {
        return await handleVrchatPasswordStep(
          context,
          username,
          password,
          twoFactorCode,
          twoFactorType
        );
      }

      return await handleStoredVrchatSessionStep(context);
    } catch (err) {
      logger.error('VRChat verify failed', {
        error: err instanceof Error ? err.message : String(err),
        authUserId,
        tokenSuffix,
        branch:
          pendingToken || (!username && !password && twoFactorCode)
            ? '2fa'
            : username && password
              ? 'password'
              : 'auto',
      });
      return jsonNoStore(
        {
          success: false,
          error: 'Verification failed. Please try again.',
        },
        { status: 500 }
      );
    }
  }

  return {
    beginVrchatVerification,
    completeVrchatVerification,
    vrchatVerify,
  };
}
