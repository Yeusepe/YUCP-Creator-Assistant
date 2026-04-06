/**
 * Verification Session Manager
 *
 * Manages verification sessions for OAuth and PKCE flows.
 * Provides API routes for beginning, callback, and completing verification.
 *
 * Security:
 * - PKCE verifier hash stored for security; raw verifier stored short-lived for token exchange
 * - Only the SHA-256 hash of the PKCE verifier is stored in Convex
 * - State encodes authUserId for callback lookup: {authUserId}:{random}
 * - Sessions expire after 15 minutes
 * - Replay protection via session status checks
 */

import { timingSafeStringEqual } from '@yucp/shared';
import { sha256Hex } from '@yucp/shared/crypto';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { createAuth } from '../auth';
import { getConvexClientFromUrl } from '../lib/convex';
import { encrypt } from '../lib/encrypt';
import { logger } from '../lib/logger';
import { getStateStore } from '../lib/stateStore';
import { sanitizePublicErrorMessage } from '../lib/userFacingErrors';
import { createApiVerificationSupportError } from '../lib/verificationSupport';
import {
  getVerificationConfig,
  modeToProvider,
  type VerificationConfig,
} from './verificationConfig';
import { createVerificationPanelRouteHandlers } from './verificationPanelRoutes';
import {
  buildVerificationCallbackUri,
  createPkceBundle,
  createVerificationState,
  getPkceVerifierStoreKey,
  PKCE_CODE_CHALLENGE_METHOD,
  parseVerificationState,
  SESSION_EXPIRY_MS,
} from './verificationSessionPrimitives';
import { createVrchatVerificationRouteHandlers } from './verificationVrchatRoutes';

export { getVerificationConfig, type VerificationConfig } from './verificationConfig';
export {
  computeCodeChallenge,
  generateCodeVerifier,
  generateState,
  hashVerifier,
  SESSION_EXPIRY_MS,
} from './verificationSessionPrimitives';

// ============================================================================
// VERIFICATION SESSION TYPES
// ============================================================================

/**
 * Verification session creation input
 */
export interface CreateSessionInput {
  /** Auth user ID */
  authUserId: string;
  /** Verification mode */
  mode: string;
  /** Optional verification method override, e.g. account_link */
  verificationMethod?: string;
  /** Redirect URI after completion */
  redirectUri: string;
  /** Discord user ID when started from Discord (for Gumroad→Discord link) */
  discordUserId?: string;
  /** Optional product ID */
  productId?: string;
  /** Optional nonce for Unity */
  nonce?: string;
  /** Optional installation hint from Unity */
  installationHint?: string;
}

/**
 * Verification session result
 */
export interface CreateSessionResult {
  /** Whether session was created successfully */
  success: boolean;
  /** Session ID */
  sessionId?: string;
  /** OAuth state parameter */
  state?: string;
  /** PKCE code verifier (client must store this for callback) */
  codeVerifier?: string;
  /** PKCE code challenge (sent to OAuth provider) */
  codeChallenge?: string;
  /** OAuth authorization URL */
  authUrl?: string;
  /** When session expires */
  expiresAt?: number;
  /** Error message if failed */
  error?: string;
}

/**
 * Callback result
 */
export interface CallbackResult {
  /** Whether callback was successful */
  success: boolean;
  /** Redirect URI to send user to */
  redirectUri?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Complete verification input
 */
export interface CompleteVerificationInput {
  /** Session ID */
  sessionId: string;
  /** Subject ID (user identity) */
  subjectId: string;
}

/**
 * Complete verification result
 */
export interface CompleteVerificationResult {
  /** Whether completion was successful */
  success: boolean;
  /** Redirect URI */
  redirectUri?: string;
  /** Error message if failed */
  error?: string;
}

// ============================================================================
// VERIFICATION SESSION MANAGER
// ============================================================================

/**
 * Verification session manager interface
 */
export interface VerificationSessionManager {
  /**
   * Begin a verification session
   * Creates a new session and returns OAuth URL
   */
  beginSession: (input: CreateSessionInput) => Promise<CreateSessionResult>;

  /**
   * Handle OAuth callback
   * Validates state, exchanges code for tokens
   */
  handleCallback: (mode: string, code: string, state: string) => Promise<CallbackResult>;

  /**
   * Complete verification session
   * Links subject to session and marks as completed
   */
  completeSession: (input: CompleteVerificationInput) => Promise<CompleteVerificationResult>;
}

/**
 * Creates a verification session manager
 */
export function createVerificationSessionManager(
  config: VerificationConfig
): VerificationSessionManager {
  /**
   * Begin a verification session
   */
  async function beginSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    try {
      // Validate redirectUri against allowed origins (baseUrl and frontendUrl)
      if (input.redirectUri) {
        try {
          const allowedOrigins = new Set([
            new URL(config.baseUrl).origin,
            new URL(config.frontendUrl).origin,
          ]);
          const parsed = new URL(input.redirectUri);
          if (!allowedOrigins.has(parsed.origin)) {
            return { success: false, error: 'Invalid redirectUri: must match application origin' };
          }
        } catch {
          return { success: false, error: 'Invalid redirectUri' };
        }
      }

      const modeConfig = getVerificationConfig(input.mode);
      if (!modeConfig) {
        return {
          success: false,
          error: `Unknown verification mode: ${input.mode}`,
        };
      }

      const { codeVerifier, codeChallenge, verifierHash } = await createPkceBundle();
      const state = createVerificationState(input.authUserId, input.mode);

      // Build OAuth URL
      const authUrl = new URL(modeConfig.authUrl);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', PKCE_CODE_CHALLENGE_METHOD);

      const redirectUri = buildVerificationCallbackUri(
        config.baseUrl,
        input.mode,
        modeConfig.callbackPath
      );
      authUrl.searchParams.set('redirect_uri', redirectUri);

      // Derive client ID from mode config (falls back to generic providerClientIds)
      const clientId = modeConfig.clientIdKey
        ? (config[modeConfig.clientIdKey] as string | undefined)
        : config.providerClientIds?.[input.mode];
      // Merge per-mode extra OAuth params with runtime overrides
      const extraOAuthParams = {
        ...modeConfig.extraOAuthParams,
        ...config.providerExtraOAuthParams?.[input.mode],
      };

      if (!clientId) {
        return {
          success: false,
          error: `${input.mode.charAt(0).toUpperCase() + input.mode.slice(1)} client ID not configured`,
        };
      }
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('scope', modeConfig.scopes.join(' '));
      for (const [k, v] of Object.entries(extraOAuthParams)) {
        authUrl.searchParams.set(k, v);
      }

      logger.info('Verification session started', {
        mode: input.mode,
        verificationMethod: input.verificationMethod ?? input.mode,
        authUserId: input.authUserId,
        statePrefix: `${state.slice(0, 8)}...`,
      });

      const expiresAt = Date.now() + SESSION_EXPIRY_MS;

      // Store session in Convex when configured
      if (config.convexUrl && config.convexApiSecret) {
        try {
          const convex = getConvexClientFromUrl(config.convexUrl);
          // Store the plaintext PKCE verifier in the ephemeral state store (never in Convex)
          const store = getStateStore();
          await store.set(getPkceVerifierStoreKey(state), codeVerifier, SESSION_EXPIRY_MS);
          // redirectUri = user's destination after verification (e.g. /verify-success?returnTo=...)
          // OAuth redirect_uri for token exchange is always baseUrl + callbackPath
          const result = await convex.mutation(api.verificationSessions.createVerificationSession, {
            apiSecret: config.convexApiSecret,
            authUserId: input.authUserId,
            mode: input.mode,
            verificationMethod: input.verificationMethod,
            state,
            pkceVerifierHash: verifierHash,
            redirectUri: input.redirectUri,
            successRedirectUri: input.redirectUri,
            discordUserId: input.discordUserId,
            nonce: input.nonce,
            productId: input.productId,
            installationHint: input.installationHint,
          });
          return {
            success: true,
            sessionId: result.sessionId,
            state,
            codeVerifier,
            codeChallenge,
            authUrl: authUrl.toString(),
            expiresAt: result.expiresAt,
          };
        } catch (err) {
          logger.error('Failed to create Convex verification session', {
            error: err instanceof Error ? err.message : String(err),
          });
          return {
            success: false,
            error: sanitizePublicErrorMessage(
              err instanceof Error ? err.message : String(err),
              'Could not start verification.'
            ),
          };
        }
      }

      // Fallback when Convex not configured (e.g. tests)
      return {
        success: true,
        state,
        codeVerifier,
        codeChallenge,
        authUrl: authUrl.toString(),
        expiresAt,
      };
    } catch (err) {
      logger.error('Failed to begin verification session', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        success: false,
        error: sanitizePublicErrorMessage(
          err instanceof Error ? err.message : String(err),
          'Could not start verification.'
        ),
      };
    }
  }

  /**
   * Handle OAuth callback
   */
  async function handleCallback(
    mode: string,
    code: string,
    state: string
  ): Promise<CallbackResult> {
    try {
      const modeConfig = getVerificationConfig(mode);
      if (!modeConfig) {
        return {
          success: false,
          error: `Unknown verification mode: ${mode}`,
        };
      }

      logger.info('Handling OAuth callback', { mode, statePrefix: `${state.slice(0, 8)}...` });

      // When Convex not configured, return placeholder (e.g. tests)
      if (!config.convexUrl || !config.convexApiSecret) {
        return {
          success: true,
          redirectUri: `${config.frontendUrl}/verification/success`,
        };
      }

      const parsedState = parseVerificationState(state);
      if (!parsedState) {
        return { success: false, error: 'Invalid state parameter' };
      }
      const { authUserId } = parsedState;

      const convex = getConvexClientFromUrl(config.convexUrl);
      const apiSecret = config.convexApiSecret;

      // Look up session
      const sessionResult = await convex.query(
        api.verificationSessions.getVerificationSessionByState,
        { apiSecret, authUserId, state }
      );

      if (!sessionResult.found || !sessionResult.session) {
        return { success: false, error: 'Session not found or expired' };
      }

      const session = sessionResult.session;
      // Use session.mode for feature branching (e.g. 'discord_role')
      // because the URL-path mode is just 'discord' for all Discord OAuth callbacks.
      const sessionMode = session.mode;
      // Retrieve the PKCE verifier from the ephemeral state store (never stored in Convex)
      const store = getStateStore();
      const verifierStoreKey = getPkceVerifierStoreKey(state);
      const codeVerifier = await store.get(verifierStoreKey);
      // Delete immediately after reading to enforce single-use
      await store.delete(verifierStoreKey);
      if (!codeVerifier) {
        return { success: false, error: 'Session missing PKCE verifier' };
      }

      // Exchange code for tokens
      const redirectUri = buildVerificationCallbackUri(
        config.baseUrl,
        mode,
        modeConfig.callbackPath
      );
      const tokenParams = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      });

      const clientId = modeConfig.clientIdKey
        ? (config[modeConfig.clientIdKey] as string | undefined)
        : config.providerClientIds?.[mode];
      const clientSecret = modeConfig.clientSecretKey
        ? (config[modeConfig.clientSecretKey] as string | undefined)
        : config.providerClientSecrets?.[mode];

      if (clientId) tokenParams.set('client_id', clientId);
      if (clientSecret) tokenParams.set('client_secret', clientSecret);

      const tokenRes = await fetch(modeConfig.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenParams.toString(),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        logger.error('Token exchange failed', { status: tokenRes.status, body: errText });
        return { success: false, error: 'Token exchange failed' };
      }

      const tokens = (await tokenRes.json()) as {
        access_token?: string;
        scope?: string;
      };
      const accessToken = tokens.access_token;
      if (!accessToken) {
        return { success: false, error: 'No access token in response' };
      }

      // For discord_role: verify guilds.members.read scope before guild member fetch
      if (sessionMode === 'discord_role') {
        const scopes = (tokens.scope ?? '').split(/\s+/).filter(Boolean);
        if (!scopes.includes('guilds.members.read')) {
          return {
            success: false,
            error: 'Please try again and grant server membership access',
          };
        }
      }

      // Get user info from provider
      const provider = modeToProvider(mode);
      if (!provider) {
        return { success: false, error: `Unknown provider for mode: ${mode}` };
      }

      let providerUserId: string;
      let username: string | undefined;
      let email: string | undefined;
      let avatarUrl: string | undefined;
      let profileUrl: string | undefined;

      if (provider === 'gumroad') {
        const meRes = await fetch('https://api.gumroad.com/v2/user', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!meRes.ok) {
          return { success: false, error: 'Failed to fetch Gumroad user' };
        }
        const me = (await meRes.json()) as {
          success?: boolean;
          user?: { user_id?: string; name?: string; email?: string };
        };
        providerUserId = me.user?.user_id ?? '';
        username = me.user?.name;
        email = me.user?.email;
      } else if (provider === 'discord') {
        const meRes = await fetch('https://discord.com/api/users/@me', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!meRes.ok) {
          return { success: false, error: 'Failed to fetch Discord user' };
        }
        const me = (await meRes.json()) as {
          id?: string;
          username?: string;
          avatar?: string;
          email?: string;
        };
        providerUserId = me.id ?? '';
        username = me.username;
        email = me.email;
        avatarUrl = me.avatar
          ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png`
          : undefined;
        profileUrl = me.id ? `https://discord.com/users/${me.id}` : undefined;
      } else {
        return { success: false, error: `Unknown provider for mode: ${mode}` };
      }

      if (!providerUserId) {
        return { success: false, error: 'Could not determine provider user ID' };
      }

      // Sync user to Convex (pass discordUserId when from Discord verify button for Gumroad→Discord link)
      const discordUserId = session.discordUserId;
      logger.info('[verification] Syncing provider user to Convex', {
        provider,
        providerUserId,
        authUserId,
        discordUserId: discordUserId ?? '(none - Gumroad account will be orphaned!)',
        sessionId: String(session._id),
      });

      const syncResult = await convex.mutation(api.identitySync.syncUserFromProvider, {
        apiSecret,
        provider,
        providerUserId,
        username,
        email,
        avatarUrl,
        profileUrl,
        discordUserId: discordUserId ?? undefined,
      });

      logger.info('[verification] syncUserFromProvider result', {
        subjectId: syncResult.subjectId,
        externalAccountId: syncResult.externalAccountId,
        isNewSubject: syncResult.isNewSubject,
        isNewExternalAccount: syncResult.isNewExternalAccount,
      });

      // For discord_role: guild member lookup, role check, entitlement grant.
      // Token is stored FIRST (regardless of role match) so it can be reused
      // for proactive scanning when new discord_role products are added.
      if (sessionMode === 'discord_role') {
        // Always store the Discord OAuth token for future proactive checks.
        // This happens before role checking - even if the user doesn't have
        // the required role right now, we want the token for later.
        try {
          const encryptionSecret = process.env.BETTER_AUTH_SECRET;
          if (encryptionSecret && syncResult.externalAccountId) {
            const tokenEncrypted = await encrypt(
              accessToken,
              encryptionSecret,
              'discord-oauth-access-token'
            );
            // Discord access tokens expire after ~7 days
            const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
            await convex.mutation(api.identitySync.storeDiscordToken, {
              apiSecret,
              externalAccountId: syncResult.externalAccountId,
              discordAccessTokenEncrypted: tokenEncrypted,
              discordTokenExpiresAt: expiresAt,
            });
            logger.info('[verification] Stored Discord token for proactive scanning', {
              externalAccountId: syncResult.externalAccountId,
            });
          }
        } catch (tokenErr) {
          // Non-fatal: don't fail the verification if token storage fails
          logger.warn('[verification] Failed to store Discord token', {
            error: tokenErr instanceof Error ? tokenErr.message : String(tokenErr),
          });
        }

        // Now check if the user has any matching roles for current rules
        const tenant = await convex.query(api.creatorProfiles.getCreatorProfile, {
          apiSecret,
          authUserId,
        });
        if (!tenant) {
          return { success: false, error: 'Tenant not found' };
        }
        const policy = tenant.policy ?? {};
        const enabled = policy.enableDiscordRoleFromOtherServers === true;
        const allowedGuildIds = policy.allowedSourceGuildIds ?? [];
        if (!enabled || allowedGuildIds.length === 0) {
          // Policy not enabled - token is still stored for when it is enabled later
          logger.info(
            '[verification] Discord role from other servers not enabled, but token stored'
          );
        } else {
          const rules = await convex.query(api.role_rules.getDiscordRoleRulesByTenant, {
            apiSecret,
            authUserId,
            sourceGuildIds: allowedGuildIds,
          });

          for (const rule of rules) {
            const {
              sourceGuildId,
              requiredRoleId,
              requiredRoleIds,
              requiredRoleMatchMode,
              productId,
            } = rule;
            const requiredIds = requiredRoleIds ?? (requiredRoleId ? [requiredRoleId] : []);
            if (!sourceGuildId || requiredIds.length === 0) continue;

            let memberRes = await fetch(
              `https://discord.com/api/v10/users/@me/guilds/${sourceGuildId}/member`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );

            if (memberRes.status === 429) {
              const retryAfter = memberRes.headers.get('Retry-After');
              const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 5000;
              await new Promise((r) => setTimeout(r, waitMs));
              memberRes = await fetch(
                `https://discord.com/api/v10/users/@me/guilds/${sourceGuildId}/member`,
                { headers: { Authorization: `Bearer ${accessToken}` } }
              );
            }
            if (memberRes.status === 403 || memberRes.status === 404) continue;
            if (!memberRes.ok) continue;

            const member = (await memberRes.json()) as { roles?: string[] };
            const roles = member.roles ?? [];
            const matchAll = requiredRoleMatchMode === 'all';
            const hasRole = matchAll
              ? requiredIds.every(
                  (id: string) => roles.includes(id) || (id === sourceGuildId && memberRes.ok)
                )
              : requiredIds.some(
                  (id: string) => roles.includes(id) || (id === sourceGuildId && memberRes.ok)
                );

            if (hasRole) {
              const sourceReference =
                productId ?? `discord_role:${sourceGuildId}:${requiredIds[0]}`;
              await convex.mutation(api.entitlements.grantEntitlement, {
                apiSecret,
                authUserId,
                subjectId: syncResult.subjectId,
                productId,
                evidence: {
                  provider: 'discord',
                  sourceReference,
                },
              });
            }
          }
        }
        // Note: we no longer fail here if no roles matched.
        // The token is stored, and entitlements are granted for matching roles.
        // Non-matching users can be retroactively granted when products change.
      }

      // Create (or reactivate) a tenant-scoped binding linking subject → external_account.
      // This is the critical step: getSubjectWithAccounts queries the bindings table
      // to find all connected provider accounts. Without a binding record, the
      // provider account is invisible to the Discord bot.
      // For discord_role: the binding is always created (Discord account linked),
      // and entitlements are granted for matching roles.
      try {
        const bindingResult = await convex.mutation(api.bindings.activateBinding, {
          apiSecret,
          authUserId,
          subjectId: syncResult.subjectId,
          externalAccountId: syncResult.externalAccountId,
          bindingType: 'verification',
        });
        logger.info('[verification] Binding created/reactivated', {
          bindingId: String(bindingResult.bindingId),
          isNew: bindingResult.isNew,
          authUserId,
          subjectId: syncResult.subjectId,
          externalAccountId: syncResult.externalAccountId,
        });
      } catch (bindErr) {
        // Log but do not fail the whole flow
        logger.error('[verification] Failed to create binding (non-fatal)', {
          error: bindErr instanceof Error ? bindErr.message : String(bindErr),
          authUserId,
          subjectId: syncResult.subjectId,
          externalAccountId: syncResult.externalAccountId,
        });
      }

      if (syncResult.externalAccountId) {
        try {
          await convex.mutation(api.subjects.upsertBuyerProviderLink, {
            apiSecret,
            subjectId: syncResult.subjectId,
            provider,
            externalAccountId: syncResult.externalAccountId,
            verificationMethod: session.verificationMethod ?? sessionMode,
            verificationSessionId: session._id,
          });
          logger.info('[verification] Buyer provider link stored', {
            provider,
            subjectId: syncResult.subjectId,
            externalAccountId: syncResult.externalAccountId,
            sessionId: String(session._id),
          });
        } catch (buyerLinkErr) {
          logger.error('[verification] Failed to store buyer provider link', {
            provider,
            error: buyerLinkErr instanceof Error ? buyerLinkErr.message : String(buyerLinkErr),
            subjectId: syncResult.subjectId,
            externalAccountId: syncResult.externalAccountId,
          });
        }
      }

      // For Gumroad: ensure purchase_facts is populated, then sync past purchases.
      // syncPastPurchasesForSubject (from syncUserFromProvider) may find 0 if backfill
      // hasn't run. Trigger backfill for tenant's products, then sync again.
      if (mode === 'gumroad' && email) {
        const normalizedEmail = email.trim().toLowerCase();
        const emailHash = await sha256Hex(normalizedEmail);
        try {
          await convex.mutation(api.backgroundSync.scheduleBackfillThenSyncForGumroadBuyer, {
            apiSecret,
            authUserId,
            subjectId: syncResult.subjectId,
            providerUserId,
            emailHash,
          });
        } catch (backfillErr) {
          logger.warn('[verification] Failed to schedule backfill+sync (non-fatal)', {
            error: backfillErr instanceof Error ? backfillErr.message : String(backfillErr),
          });
        }
      }

      // Complete verification session
      const completeResult = await convex.mutation(
        api.verificationSessions.completeVerificationSession,
        {
          apiSecret,
          sessionId: session._id,
          subjectId: syncResult.subjectId,
        }
      );

      logger.info('[verification] Session completed, redirecting user', {
        sessionId: String(session._id),
        subjectId: syncResult.subjectId,
        redirectUri: completeResult.redirectUri,
      });

      return {
        success: true,
        redirectUri: completeResult.redirectUri,
      };
    } catch (err) {
      logger.error('Failed to handle OAuth callback', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        success: false,
        error: sanitizePublicErrorMessage(
          err instanceof Error ? err.message : String(err),
          'Could not complete verification.'
        ),
      };
    }
  }

  /**
   * Complete verification session
   */
  async function completeSession(
    input: CompleteVerificationInput
  ): Promise<CompleteVerificationResult> {
    try {
      logger.info('Completing verification session', {
        sessionId: input.sessionId,
        subjectId: input.subjectId,
      });

      if (!config.convexUrl || !config.convexApiSecret) {
        return {
          success: true,
          redirectUri: `${config.frontendUrl}/verification/complete`,
        };
      }

      const convex = getConvexClientFromUrl(config.convexUrl);
      const result = await convex.mutation(api.verificationSessions.completeVerificationSession, {
        apiSecret: config.convexApiSecret,
        sessionId: input.sessionId,
        subjectId: input.subjectId,
      });

      if (result.alreadyCompleted) {
        return {
          success: false,
          error: 'Session already completed',
          redirectUri: result.redirectUri,
        };
      }

      return {
        success: result.success,
        redirectUri: result.redirectUri,
      };
    } catch (err) {
      logger.error('Failed to complete verification session', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        success: false,
        error: sanitizePublicErrorMessage(
          err instanceof Error ? err.message : String(err),
          'Could not finish verification.'
        ),
      };
    }
  }

  return {
    beginSession,
    handleCallback,
    completeSession,
  };
}

// ============================================================================
// ROUTE HANDLERS
// ============================================================================

/**
 * Creates route handlers for verification endpoints
 */
export function createVerificationRoutes(config: VerificationConfig) {
  const manager = createVerificationSessionManager(config);

  function hasValidApiSecret(value: string | undefined): boolean {
    return typeof value === 'string' && timingSafeStringEqual(value, config.convexApiSecret);
  }

  const { bindVerifyPanel, refreshVerifyPanel } = createVerificationPanelRouteHandlers({
    config,
    hasValidApiSecret,
    logger,
  });
  const { beginVrchatVerification, completeVrchatVerification, vrchatVerify } =
    createVrchatVerificationRouteHandlers({
      config,
      logger,
    });

  /**
   * POST /api/verification/begin or GET /api/verification/begin?authUserId=&mode=&redirectUri=
   * Starts a verification session. GET returns redirect to OAuth URL (for Discord link buttons).
   * For mode=vrchat, redirects to /vrchat-verify?token=xxx instead of OAuth.
   */
  async function beginVerification(request: Request): Promise<Response> {
    let body: (CreateSessionInput & { mode?: string }) | undefined;
    try {
      if (request.method === 'GET') {
        const url = new URL(request.url);
        body = {
          authUserId: url.searchParams.get('authUserId') ?? '',
          mode: (url.searchParams.get('mode') ?? 'gumroad') as CreateSessionInput['mode'],
          verificationMethod: url.searchParams.get('verificationMethod') ?? undefined,
          redirectUri: url.searchParams.get('redirectUri') ?? `${config.baseUrl}/verify-success`,
          discordUserId: url.searchParams.get('discordUserId') ?? undefined,
        };
      } else {
        body = (await request.json()) as CreateSessionInput;
      }

      if (!body.authUserId || !body.mode || !body.redirectUri) {
        return Response.json({ success: false, error: 'Missing required fields' }, { status: 400 });
      }

      if ((body as { mode?: string }).mode === 'vrchat') {
        return beginVrchatVerification({
          authUserId: body.authUserId,
          discordUserId: body.discordUserId,
          redirectUri: body.redirectUri,
        });
      }

      const result = await manager.beginSession(body);

      if (!result.success) {
        if (request.method === 'GET' && result.error) {
          return Response.redirect(
            `${config.baseUrl}/verify-error?error=${encodeURIComponent(result.error)}`,
            302
          );
        }
        return Response.json(result, { status: 400 });
      }

      if (request.method === 'GET' && result.authUrl) {
        return Response.redirect(result.authUrl, 302);
      }

      return Response.json(result, { status: 200 });
    } catch (err) {
      const support = await createApiVerificationSupportError(logger, {
        discordUserId: body?.discordUserId,
        error: err,
        provider: body?.mode,
        stage: 'begin_verification',
        authUserId: body?.authUserId,
      });
      if (request.method === 'GET') {
        return Response.redirect(
          `${config.baseUrl}/verify-error?error=internal_error&supportCode=${encodeURIComponent(support.supportCode)}`,
          302
        );
      }
      return Response.json(
        { success: false, error: 'Internal server error', supportCode: support.supportCode },
        { status: 500 }
      );
    }
  }

  /**
   * GET /api/verification/callback/:mode
   * Handles OAuth callback from providers
   */
  async function handleVerificationCallback(request: Request): Promise<Response> {
    let mode: string | undefined;
    try {
      const url = new URL(request.url);
      const pathParts = url.pathname.split('/');
      mode = pathParts[pathParts.length - 1];

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        logger.error('OAuth callback error', { error });
        return Response.redirect(
          `${config.baseUrl}/verify-error?error=${encodeURIComponent(error)}`,
          302
        );
      }

      if (!code || !state) {
        return Response.redirect(`${config.baseUrl}/verify-error?error=missing_parameters`, 302);
      }

      const result = await manager.handleCallback(mode, code, state);

      if (!result.success) {
        return Response.redirect(
          `${config.baseUrl}/verify-error?error=${encodeURIComponent(result.error ?? 'unknown_error')}`,
          302
        );
      }

      if (!result.redirectUri) {
        return Response.redirect(`${config.baseUrl}/verify-error?error=missing_redirect`, 302);
      }

      return Response.redirect(result.redirectUri, 302);
    } catch (err) {
      const support = await createApiVerificationSupportError(logger, {
        error: err,
        provider: mode,
        stage: 'verification_callback',
      });
      return Response.redirect(
        `${config.baseUrl}/verify-error?error=internal_error&supportCode=${encodeURIComponent(support.supportCode)}`,
        302
      );
    }
  }

  /**
   * POST /api/verification/complete
   * Completes a verification session
   */
  async function completeVerification(request: Request): Promise<Response> {
    let body: CompleteVerificationInput | undefined;
    try {
      body = (await request.json()) as CompleteVerificationInput;

      if (!body.sessionId || !body.subjectId) {
        return Response.json({ success: false, error: 'Missing required fields' }, { status: 400 });
      }

      const result = await manager.completeSession(body);

      if (!result.success) {
        return Response.json(result, { status: 400 });
      }

      return Response.json(result, { status: 200 });
    } catch (err) {
      const support = await createApiVerificationSupportError(logger, {
        error: err,
        stage: 'complete_verification',
      });
      return Response.json(
        { success: false, error: 'Internal server error', supportCode: support.supportCode },
        { status: 500 }
      );
    }
  }

  /**
   * POST /api/verification/complete-license
   * Completes license verification - ties license to subject, grants entitlements
   */
  async function completeLicenseVerification(request: Request): Promise<Response> {
    let body:
      | {
          apiSecret?: string;
          licenseKey?: string;
          provider?: string;
          productId?: string;
          authUserId?: string;
          subjectId?: string;
          discordUserId?: string;
        }
      | undefined;
    try {
      body = (await request.json()) as NonNullable<typeof body>;

      if (!hasValidApiSecret(body.apiSecret)) {
        return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
      }

      const { handleCompleteLicense } = await import('./completeLicense');
      const result = await handleCompleteLicense(config, {
        licenseKey: body.licenseKey ?? '',
        provider: body.provider,
        productId: body.productId,
        authUserId: body.authUserId ?? '',
        subjectId: body.subjectId ?? '',
      });

      if (!result.success) {
        return Response.json(result, { status: 400 });
      }

      return Response.json(result, { status: 200 });
    } catch (err) {
      const support = await createApiVerificationSupportError(logger, {
        discordUserId: body?.discordUserId,
        error: err,
        stage: 'complete_license_verification',
        authUserId: body?.authUserId,
      });
      return Response.json(
        { success: false, error: 'Internal server error', supportCode: support.supportCode },
        { status: 500 }
      );
    }
  }

  /**
   * POST /api/verification/disconnect
   * Removes a connected external account
   */
  async function disconnectVerification(request: Request): Promise<Response> {
    let body:
      | {
          apiSecret?: string;
          authUserId?: string;
          subjectId?: string;
          provider?: string;
        }
      | undefined;
    try {
      body = (await request.json()) as NonNullable<typeof body>;

      if (!hasValidApiSecret(body.apiSecret)) {
        return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
      }

      if (!body.authUserId || !body.subjectId || !body.provider) {
        return Response.json({ success: false, error: 'Missing required fields' }, { status: 400 });
      }

      const convex = getConvexClientFromUrl(config.convexUrl);
      const betterAuth = createAuth({
        baseUrl: config.baseUrl,
        convexSiteUrl: config.convexUrl
          ? config.convexUrl.replace('.convex.cloud', '.convex.site')
          : '',
        convexUrl: config.convexUrl,
      });
      const authUserId = body.authUserId as string;
      const subjectId = body.subjectId as Id<'subjects'>;

      let vrchatUserIdToClear: string | undefined;
      if (body.provider === 'vrchat') {
        const accountsResult = await convex.query(api.subjects.getSubjectWithAccounts, {
          apiSecret: config.convexApiSecret,
          subjectId,
          authUserId,
        });
        const vrchatAccount = accountsResult.found
          ? accountsResult.externalAccounts?.find(
              (account: { provider: string; providerUserId: string }) =>
                account.provider === 'vrchat'
            )
          : null;
        vrchatUserIdToClear = vrchatAccount?.providerUserId;
      }

      // Revoke entitlements from this provider and emit role_removal jobs first.
      // Without this, roles would never be removed when disconnecting.
      await convex.mutation(api.entitlements.revokeEntitlementsForProviderDisconnect, {
        apiSecret: config.convexApiSecret,
        authUserId,
        subjectId,
        provider: body.provider,
      });

      const disconnected = await convex.mutation(api.providerConnections.removeAccountForSubject, {
        apiSecret: config.convexApiSecret,
        authUserId,
        subjectId,
        provider: body.provider,
      });

      if (!disconnected) {
        return Response.json(
          { success: false, error: 'Failed to disconnect account' },
          { status: 400 }
        );
      }

      if (body.provider === 'vrchat' && vrchatUserIdToClear) {
        try {
          await betterAuth.clearVrchatSessionForUser({
            id: vrchatUserIdToClear,
          });
        } catch (error) {
          logger.warn('Disconnect verification: failed to clear BetterAuth VRChat session', {
            subjectId: body.subjectId,
            vrchatUserId: vrchatUserIdToClear,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // If this was the last account, revoke any remaining entitlements
      // (e.g. from manual grants or sourceProvider mismatch)
      const accountsResult = await convex.query(api.subjects.getSubjectWithAccounts, {
        apiSecret: config.convexApiSecret,
        subjectId,
        authUserId,
      });
      const hasRemainingAccounts =
        accountsResult.found && accountsResult.externalAccounts?.length > 0;
      if (!hasRemainingAccounts) {
        await convex.mutation(api.entitlements.revokeAllEntitlementsForSubject, {
          apiSecret: config.convexApiSecret,
          authUserId,
          subjectId,
        });
      }

      return Response.json({ success: true }, { status: 200 });
    } catch (err) {
      const support = await createApiVerificationSupportError(logger, {
        error: err,
        provider: body?.provider,
        stage: 'disconnect_verification',
        authUserId: body?.authUserId,
      });
      return Response.json(
        { success: false, error: 'Internal server error', supportCode: support.supportCode },
        { status: 500 }
      );
    }
  }

  return {
    beginVerification,
    bindVerifyPanel,
    handleVerificationCallback,
    completeVerification,
    completeLicenseVerification,
    completeVrchatVerification,
    refreshVerifyPanel,
    vrchatVerify,
    disconnectVerification,
  };
}

/**
 * Mounts verification routes on a route map
 */
export function mountVerificationRoutes(
  config: VerificationConfig
): Map<string, (request: Request) => Promise<Response>> {
  return mountVerificationRouteHandlers(createVerificationRoutes(config));
}

export function mountVerificationRouteHandlers(
  routes: VerificationRouteHandlers
): Map<string, (request: Request) => Promise<Response>> {
  const routeMap = new Map<string, (request: Request) => Promise<Response>>();

  routeMap.set('/api/verification/begin', routes.beginVerification);
  routeMap.set('/api/verification/panel/bind', routes.bindVerifyPanel);
  routeMap.set('/api/verification/panel/refresh', routes.refreshVerifyPanel);
  routeMap.set('/api/verification/callback/gumroad', routes.handleVerificationCallback);
  routeMap.set('/api/verification/callback/discord', routes.handleVerificationCallback);
  routeMap.set('/api/verification/complete', routes.completeVerification);
  routeMap.set('/api/verification/complete-license', routes.completeLicenseVerification);
  routeMap.set('/api/verification/complete-vrchat', routes.completeVrchatVerification);
  routeMap.set('/api/verification/vrchat-verify', routes.vrchatVerify);
  routeMap.set('/api/verification/disconnect', routes.disconnectVerification);

  return routeMap;
}
export type VerificationRouteHandlers = ReturnType<typeof createVerificationRoutes>;
