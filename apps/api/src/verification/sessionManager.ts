/**
 * Verification Session Manager
 *
 * Manages verification sessions for OAuth and PKCE flows.
 * Provides API routes for beginning, callback, and completing verification.
 *
 * Security:
 * - PKCE verifier is hashed before storage (never stored plaintext)
 * - State encodes tenantId for callback lookup: {tenantId}:{random}
 * - Sessions expire after 15 minutes
 * - Replay protection via session status checks
 */

import { createLogger } from '@yucp/shared';
import { getConvexClientFromUrl } from '../lib/convex';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

// Session expiry: 15 minutes
export const SESSION_EXPIRY_MS = 15 * 60 * 1000;

// ============================================================================
// CRYPTO UTILITIES
// ============================================================================

/**
 * Generates a cryptographically secure random string
 */
export function generateSecureRandom(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generates a cryptographically secure state parameter
 */
export function generateState(): string {
  return generateSecureRandom(32);
}

/**
 * Generates a PKCE code verifier (43-128 characters)
 * RFC 7636 recommends 43-128 characters
 */
export function generateCodeVerifier(): string {
  return generateSecureRandom(64);
}

/**
 * Computes PKCE code challenge from verifier
 * code_challenge = BASE64URL(SHA256(code_verifier))
 */
export async function computeCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  // Base64url encode (no padding)
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Hashes the PKCE verifier for storage
 * We store the hash, not the plaintext verifier
 */
export async function hashVerifier(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  // Return hex string
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================================
// VERIFICATION MODE CONFIGURATIONS
// ============================================================================

/**
 * Verification mode configuration
 */
export interface VerificationModeConfig {
  /** OAuth authorization URL */
  authUrl: string;
  /** OAuth token URL */
  tokenUrl: string;
  /** Required OAuth scopes */
  scopes: string[];
  /** Callback path */
  callbackPath: string;
}

/**
 * Gumroad OAuth configuration
 */
export const GUMROAD_CONFIG: VerificationModeConfig = {
  authUrl: 'https://gumroad.com/oauth/authorize',
  tokenUrl: 'https://api.gumroad.com/oauth/token',
  scopes: ['view_profile', 'view_sales'],
  callbackPath: '/api/verification/callback/gumroad',
};

/**
 * Discord role verification configuration
 * Uses Discord OAuth for user identity verification
 */
export const DISCORD_ROLE_CONFIG: VerificationModeConfig = {
  authUrl: 'https://discord.com/api/oauth2/authorize',
  tokenUrl: 'https://discord.com/api/oauth2/token',
  scopes: ['identify', 'guilds', 'guilds.members.read'],
  callbackPath: '/api/verification/callback/discord',
};

/**
 * Jinxxy OAuth configuration
 */
export const JINXXY_CONFIG: VerificationModeConfig = {
  authUrl: 'https://jinxxy.com/oauth/authorize',
  tokenUrl: 'https://api.jinxxy.com/oauth/token',
  scopes: ['user:read', 'products:read', 'purchases:read'],
  callbackPath: '/api/verification/callback/jinxxy',
};

/**
 * Get configuration for a verification mode.
 * Callback path uses 'discord' but internal mode is 'discord_role'.
 */
export function getVerificationConfig(mode: string): VerificationModeConfig | null {
  switch (mode) {
    case 'gumroad':
      return GUMROAD_CONFIG;
    case 'discord':
    case 'discord_role':
      return DISCORD_ROLE_CONFIG;
    case 'jinxxy':
      return JINXXY_CONFIG;
    default:
      return null;
  }
}

/** Map callback path mode to Convex/identitySync provider name */
function modeToProvider(mode: string): 'gumroad' | 'discord' | 'jinxxy' | null {
  switch (mode) {
    case 'gumroad':
      return 'gumroad';
    case 'discord':
    case 'discord_role':
      return 'discord';
    case 'jinxxy':
      return 'jinxxy';
    default:
      return null;
  }
}

// ============================================================================
// VERIFICATION SESSION TYPES
// ============================================================================

/**
 * Verification session creation input
 */
export interface CreateSessionInput {
  /** Tenant ID */
  tenantId: string;
  /** Verification mode */
  mode: 'gumroad' | 'discord_role' | 'jinxxy' | 'manual';
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
  handleCallback: (
    mode: string,
    code: string,
    state: string
  ) => Promise<CallbackResult>;

  /**
   * Complete verification session
   * Links subject to session and marks as completed
   */
  completeSession: (
    input: CompleteVerificationInput
  ) => Promise<CompleteVerificationResult>;
}

/**
 * Configuration for verification session manager
 */
export interface VerificationConfig {
  /** Base URL for the API */
  baseUrl: string;
  /** Frontend URL for redirects */
  frontendUrl: string;
  /** Convex URL for backend calls */
  convexUrl: string;
  /** Convex API secret for authenticated mutations */
  convexApiSecret: string;
  /** Gumroad client ID */
  gumroadClientId?: string;
  /** Gumroad client secret */
  gumroadClientSecret?: string;
  /** Discord client ID */
  discordClientId?: string;
  /** Discord client secret */
  discordClientSecret?: string;
  /** Jinxxy client ID */
  jinxxyClientId?: string;
  /** Jinxxy client secret */
  jinxxyClientSecret?: string;
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
      const modeConfig = getVerificationConfig(input.mode);
      if (!modeConfig) {
        return {
          success: false,
          error: `Unknown verification mode: ${input.mode}`,
        };
      }

      // Generate PKCE parameters
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await computeCodeChallenge(codeVerifier);
      const verifierHash = await hashVerifier(codeVerifier);

      // Generate state for callback lookup
      // Use verify_gumroad: prefix to distinguish from connect_gumroad:
      const state = input.mode === 'gumroad'
        ? `verify_gumroad:${input.tenantId}:${generateSecureRandom(48)}`
        : `${input.tenantId}:${generateSecureRandom(48)}`;

      // Build OAuth URL
      const authUrl = new URL(modeConfig.authUrl);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');

      // For Gumroad, use the unified callback URI to comply with Gumroad's single redirect URI limit
      const redirectUri = input.mode === 'gumroad'
        ? `${config.baseUrl}/api/connect/gumroad/callback`
        : `${config.baseUrl}${modeConfig.callbackPath}`;
      authUrl.searchParams.set('redirect_uri', redirectUri);

      // Add mode-specific parameters
      switch (input.mode) {
        case 'gumroad':
          if (!config.gumroadClientId) {
            return { success: false, error: 'Gumroad client ID not configured' };
          }
          authUrl.searchParams.set('client_id', config.gumroadClientId);
          authUrl.searchParams.set('scope', modeConfig.scopes.join(' '));
          break;

        case 'discord_role':
          if (!config.discordClientId) {
            return { success: false, error: 'Discord client ID not configured' };
          }
          authUrl.searchParams.set('client_id', config.discordClientId);
          authUrl.searchParams.set('scope', modeConfig.scopes.join(' '));
          authUrl.searchParams.set('prompt', 'consent'); // Force re-approve for guilds.members.read
          break;

        case 'jinxxy':
          if (!config.jinxxyClientId) {
            return { success: false, error: 'Jinxxy client ID not configured' };
          }
          authUrl.searchParams.set('client_id', config.jinxxyClientId);
          authUrl.searchParams.set('scope', modeConfig.scopes.join(' '));
          break;
      }

      logger.info('Verification session started', {
        mode: input.mode,
        tenantId: input.tenantId,
        state,
      });

      const expiresAt = Date.now() + SESSION_EXPIRY_MS;

      // Store session in Convex when configured
      if (config.convexUrl && config.convexApiSecret) {
        try {
          const convex = getConvexClientFromUrl(config.convexUrl);
          // redirectUri = user's destination after verification (e.g. /verify-success?returnTo=...)
          // OAuth redirect_uri for token exchange is always baseUrl + callbackPath
          const result = await convex.mutation(
            'verificationSessions:createVerificationSession' as any,
            {
              apiSecret: config.convexApiSecret,
              tenantId: input.tenantId,
              mode: input.mode,
              state,
              pkceVerifierHash: verifierHash,
              pkceVerifier: codeVerifier,
              redirectUri: input.redirectUri,
              successRedirectUri: input.redirectUri,
              discordUserId: input.discordUserId,
              nonce: input.nonce,
              productId: input.productId,
              installationHint: input.installationHint,
            }
          );
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
            error: err instanceof Error ? err.message : String(err),
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
        error: err instanceof Error ? err.message : String(err),
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

      logger.info('Handling OAuth callback', { mode, state });

      // When Convex not configured, return placeholder (e.g. tests)
      if (!config.convexUrl || !config.convexApiSecret) {
        return {
          success: true,
          redirectUri: `${config.frontendUrl}/verification/success`,
        };
      }

      // Parse tenantId from state. Format can be:
      // - {tenantId}:{random}
      // - {prefix}:{tenantId}:{random} (e.g., verify_gumroad:{tenantId}:{random})
      const parts = state.split(':');
      if (parts.length < 2) {
        return { success: false, error: 'Invalid state parameter' };
      }

      // If 3 parts, the middle one is tenantId (e.g., prefix:tenantId:random)
      // If 2 parts, the first one is tenantId (e.g., tenantId:random)
      const tenantId = parts.length >= 3 ? parts[1] : parts[0];

      const convex = getConvexClientFromUrl(config.convexUrl);
      const apiSecret = config.convexApiSecret;

      // Look up session
      const sessionResult = await convex.query(
        'verificationSessions:getVerificationSessionByState' as any,
        { apiSecret, tenantId, state }
      );

      if (!sessionResult.found || !sessionResult.session) {
        return { success: false, error: 'Session not found or expired' };
      }

      const session = sessionResult.session;
      const codeVerifier = session.pkceVerifier;
      if (!codeVerifier) {
        return { success: false, error: 'Session missing PKCE verifier' };
      }

      // Exchange code for tokens
      const redirectUri = mode === 'gumroad'
        ? `${config.baseUrl}/api/connect/gumroad/callback`
        : `${config.baseUrl}${modeConfig.callbackPath}`;
      const tokenParams = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      });

      let clientId: string | undefined;
      let clientSecret: string | undefined;
      switch (mode) {
        case 'gumroad':
          clientId = config.gumroadClientId;
          clientSecret = config.gumroadClientSecret;
          break;
        case 'discord':
        case 'discord_role':
          clientId = config.discordClientId;
          clientSecret = config.discordClientSecret;
          break;
        case 'jinxxy':
          clientId = config.jinxxyClientId;
          clientSecret = config.jinxxyClientSecret;
          break;
      }

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
      if (mode === 'discord_role') {
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
        const meRes = await fetch(`https://api.gumroad.com/v2/user?access_token=${encodeURIComponent(accessToken)}`);
        if (!meRes.ok) {
          return { success: false, error: 'Failed to fetch Gumroad user' };
        }
        const me = (await meRes.json()) as { success?: boolean; user?: { user_id?: string; name?: string; email?: string } };
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
        // Jinxxy - use generic pattern
        const meRes = await fetch('https://api.jinxxy.com/me', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!meRes.ok) {
          return { success: false, error: 'Failed to fetch Jinxxy user' };
        }
        const me = (await meRes.json()) as { id?: string; username?: string; email?: string };
        providerUserId = me.id ?? '';
        username = me.username;
        email = me.email;
      }

      if (!providerUserId) {
        return { success: false, error: 'Could not determine provider user ID' };
      }

      // Sync user to Convex (pass discordUserId when from Discord verify button for Gumroad→Discord link)
      const discordUserId = session.discordUserId;
      logger.info('[verification] Syncing provider user to Convex', {
        provider,
        providerUserId,
        tenantId,
        discordUserId: discordUserId ?? '(none - Gumroad account will be orphaned!)',
        sessionId: String(session._id),
      });

      const syncResult = await convex.mutation(
        'identitySync:syncUserFromProvider' as any,
        {
          apiSecret,
          provider,
          providerUserId,
          username,
          email,
          avatarUrl,
          profileUrl,
          discordUserId: discordUserId ?? undefined,
        }
      );

      logger.info('[verification] syncUserFromProvider result', {
        subjectId: syncResult.subjectId,
        externalAccountId: syncResult.externalAccountId,
        isNewSubject: syncResult.isNewSubject,
        isNewExternalAccount: syncResult.isNewExternalAccount,
      });

      // Create (or reactivate) a tenant-scoped binding linking subject → external_account.
      // This is the critical step: getSubjectWithAccounts queries the bindings table
      // to find all connected provider accounts. Without a binding record, the
      // Gumroad account is invisible to the Discord bot.
      try {
        const bindingResult = await convex.mutation(
          'bindings:activateBinding' as any,
          {
            apiSecret,
            tenantId,
            subjectId: syncResult.subjectId,
            externalAccountId: syncResult.externalAccountId,
            bindingType: 'verification',
          }
        );
        logger.info('[verification] Binding created/reactivated', {
          bindingId: String(bindingResult.bindingId),
          isNew: bindingResult.isNew,
          tenantId,
          subjectId: syncResult.subjectId,
          externalAccountId: syncResult.externalAccountId,
        });
      } catch (bindErr) {
        // Log but do not fail the whole flow
        logger.error('[verification] Failed to create binding (non-fatal)', {
          error: bindErr instanceof Error ? bindErr.message : String(bindErr),
          tenantId,
          subjectId: syncResult.subjectId,
          externalAccountId: syncResult.externalAccountId,
        });
      }

      // For discord_role: guild member lookup, role check, entitlement grant
      if (mode === 'discord_role') {
        const tenant = await convex.query('tenants:getTenant' as any, {
          tenantId,
        });
        if (!tenant) {
          return { success: false, error: 'Tenant not found' };
        }
        const policy = tenant.policy ?? {};
        const enabled = policy.enableDiscordRoleFromOtherServers === true;
        const allowedGuildIds = policy.allowedSourceGuildIds ?? [];
        if (!enabled || allowedGuildIds.length === 0) {
          return {
            success: false,
            error: 'Discord role verification from other servers is not enabled',
          };
        }

        const rules = await convex.query(
          'role_rules:getDiscordRoleRulesByTenant' as any,
          {
            apiSecret,
            tenantId,
            sourceGuildIds: allowedGuildIds,
          }
        );

        let grantedAny = false;
        for (const rule of rules) {
          const { sourceGuildId, requiredRoleId, productId } = rule;
          if (!sourceGuildId || !requiredRoleId) continue;

          let memberRes = await fetch(
            `https://discord.com/api/v10/users/@me/guilds/${sourceGuildId}/member`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );

          if (memberRes.status === 429) {
            const retryAfter = memberRes.headers.get('Retry-After');
            const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
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
          const hasRole =
            roles.includes(requiredRoleId) ||
            (requiredRoleId === sourceGuildId && memberRes.ok);

          if (hasRole) {
            const sourceReference = `discord_role:${sourceGuildId}:${requiredRoleId}`;
            await convex.mutation('entitlements:grantEntitlement' as any, {
              apiSecret,
              tenantId,
              subjectId: syncResult.subjectId,
              productId: productId ?? sourceReference,
              evidence: {
                provider: 'discord',
                sourceReference,
              },
            });
            grantedAny = true;
          }
        }

        if (!grantedAny) {
          return {
            success: false,
            error: "You don't have the required role in the source server",
          };
        }
      }

      // Complete verification session
      const completeResult = await convex.mutation(
        'verificationSessions:completeVerificationSession' as any,
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
        error: err instanceof Error ? err.message : String(err),
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
      const result = await convex.mutation(
        'verificationSessions:completeVerificationSession' as any,
        {
          apiSecret: config.convexApiSecret,
          sessionId: input.sessionId,
          subjectId: input.subjectId,
        }
      );

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
        error: err instanceof Error ? err.message : String(err),
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

  /**
   * POST /api/verification/begin or GET /api/verification/begin?tenantId=&mode=&redirectUri=
   * Starts a verification session. GET returns redirect to OAuth URL (for Discord link buttons).
   */
  async function beginVerification(request: Request): Promise<Response> {
    try {
      let body: CreateSessionInput;
      if (request.method === 'GET') {
        const url = new URL(request.url);
        body = {
          tenantId: url.searchParams.get('tenantId') ?? '',
          mode: (url.searchParams.get('mode') ?? 'gumroad') as CreateSessionInput['mode'],
          redirectUri: url.searchParams.get('redirectUri') ?? config.baseUrl + '/verify-success',
          discordUserId: url.searchParams.get('discordUserId') ?? undefined,
        };
      } else {
        body = (await request.json()) as CreateSessionInput;
      }

      if (!body.tenantId || !body.mode || !body.redirectUri) {
        return Response.json(
          { success: false, error: 'Missing required fields' },
          { status: 400 }
        );
      }

      const result = await manager.beginSession(body);

      if (!result.success) {
        if (request.method === 'GET' && result.error) {
          return Response.redirect(
            `${config.frontendUrl}/verification/error?error=${encodeURIComponent(result.error)}`,
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
      logger.error('Begin verification failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { success: false, error: 'Internal server error' },
        { status: 500 }
      );
    }
  }

  /**
   * GET /api/verification/callback/:mode
   * Handles OAuth callback from providers
   */
  async function handleVerificationCallback(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const pathParts = url.pathname.split('/');
      const mode = pathParts[pathParts.length - 1];

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
        return Response.redirect(
          `${config.baseUrl}/verify-error?error=missing_parameters`,
          302
        );
      }

      const result = await manager.handleCallback(mode, code, state);

      if (!result.success) {
        return Response.redirect(
          `${config.baseUrl}/verify-error?error=${encodeURIComponent(result.error ?? 'unknown_error')}`,
          302
        );
      }

      return Response.redirect(result.redirectUri!, 302);
    } catch (err) {
      logger.error('Verification callback failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.redirect(
        `${config.baseUrl}/verify-error?error=internal_error`,
        302
      );
    }
  }

  /**
   * POST /api/verification/complete
   * Completes a verification session
   */
  async function completeVerification(request: Request): Promise<Response> {
    try {
      const body = await request.json() as CompleteVerificationInput;

      if (!body.sessionId || !body.subjectId) {
        return Response.json(
          { success: false, error: 'Missing required fields' },
          { status: 400 }
        );
      }

      const result = await manager.completeSession(body);

      if (!result.success) {
        return Response.json(result, { status: 400 });
      }

      return Response.json(result, { status: 200 });
    } catch (err) {
      logger.error('Complete verification failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { success: false, error: 'Internal server error' },
        { status: 500 }
      );
    }
  }

  /**
   * POST /api/verification/complete-license
   * Completes license verification - ties license to subject, grants entitlements
   */
  async function completeLicenseVerification(request: Request): Promise<Response> {
    try {
      const body = (await request.json()) as {
        licenseKey?: string;
        productId?: string;
        tenantId?: string;
        subjectId?: string;
      };

      const { handleCompleteLicense } = await import('./completeLicense');
      const result = await handleCompleteLicense(config, {
        licenseKey: body.licenseKey ?? '',
        productId: body.productId,
        tenantId: body.tenantId ?? '',
        subjectId: body.subjectId ?? '',
      });

      if (!result.success) {
        return Response.json(result, { status: 400 });
      }

      return Response.json(result, { status: 200 });
    } catch (err) {
      logger.error('Complete license verification failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { success: false, error: 'Internal server error' },
        { status: 500 }
      );
    }
  }

  /**
   * POST /api/verification/disconnect
   * Removes a connected external account
   */
  async function disconnectVerification(request: Request): Promise<Response> {
    try {
      const body = await request.json() as {
        tenantId?: string;
        subjectId?: string;
        provider?: string;
      };

      if (!body.tenantId || !body.subjectId || !body.provider) {
        return Response.json(
          { success: false, error: 'Missing required fields' },
          { status: 400 }
        );
      }

      const convex = getConvexClientFromUrl(config.convexUrl);
      const { api } = await import('../../../../convex/_generated/api');

      // Revoke entitlements from this provider and emit role_removal jobs first.
      // Without this, roles would never be removed when disconnecting.
      await convex.mutation(api.entitlements.revokeEntitlementsForProviderDisconnect as any, {
        apiSecret: config.convexApiSecret,
        tenantId: body.tenantId,
        subjectId: body.subjectId,
        provider: body.provider,
      });

      const disconnected = await convex.mutation(api.providerConnections.removeAccountForSubject as any, {
        apiSecret: config.convexApiSecret,
        tenantId: body.tenantId,
        subjectId: body.subjectId,
        provider: body.provider,
      });

      if (!disconnected) {
        return Response.json(
          { success: false, error: 'Failed to disconnect account' },
          { status: 400 }
        );
      }

      return Response.json({ success: true }, { status: 200 });
    } catch (err) {
      logger.error('Disconnect verification failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { success: false, error: 'Internal server error' },
        { status: 500 }
      );
    }
  }

  return {
    beginVerification,
    handleVerificationCallback,
    completeVerification,
    completeLicenseVerification,
    disconnectVerification,
  };
}

/**
 * Mounts verification routes on a route map
 */
export function mountVerificationRoutes(
  config: VerificationConfig
): Map<string, (request: Request) => Promise<Response>> {
  const routes = createVerificationRoutes(config);
  const routeMap = new Map<string, (request: Request) => Promise<Response>>();

  routeMap.set('/api/verification/begin', routes.beginVerification);
  routeMap.set('/api/verification/callback/gumroad', routes.handleVerificationCallback);
  routeMap.set('/api/verification/callback/discord', routes.handleVerificationCallback);
  routeMap.set('/api/verification/callback/jinxxy', routes.handleVerificationCallback);
  routeMap.set('/api/verification/complete', routes.completeVerification);
  routeMap.set('/api/verification/complete-license', routes.completeLicenseVerification);
  routeMap.set('/api/verification/disconnect', routes.disconnectVerification);

  return routeMap;
}
export type VerificationRouteHandlers = ReturnType<typeof createVerificationRoutes>;
