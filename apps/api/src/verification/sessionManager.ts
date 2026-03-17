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

import { type TwoFactorAuthType, VrchatApiClient, type VrchatCurrentUser } from '@yucp/providers';
import type { VrchatSessionTokens } from '@yucp/providers/vrchat';
import { createLogger, timingSafeStringEqual } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { createAuth, type VrchatOwnershipPayload, type VrchatSessionTokensPayload } from '../auth';
import { getConvexClientFromUrl } from '../lib/convex';
import { encrypt, decrypt } from '../lib/encrypt';
import { getStateStore } from '../lib/stateStore';
import { sanitizePublicErrorMessage } from '../lib/userFacingErrors';
import { createApiVerificationSupportError } from '../lib/verificationSupport';
import {
  clearPendingVrchatState,
  createPendingVrchatState,
  readPendingVrchatState,
} from './vrchatPending';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

// Session expiry: 15 minutes
export const SESSION_EXPIRY_MS = 15 * 60 * 1000;
const VRCHAT_VERIFY_ATTEMPTS = new Map<string, { count: number; resetAt: number }>();
const VERIFY_PANEL_PREFIX = 'verify_panel:';
const VERIFY_PANEL_TTL_MS = 15 * 60 * 1000;
// Prefix for PKCE verifiers stored in the state store (never stored in Convex)
const PKCE_VERIFIER_PREFIX = 'pkce_verifier:';
const INTERACTION_TOKEN_PURPOSE = 'verify-panel-interaction-token';

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

async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
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
  /**
   * Key in VerificationConfig for the OAuth client ID.
   * If omitted, falls back to providerClientIds[mode].
   */
  clientIdKey?: keyof VerificationConfig;
  /**
   * Key in VerificationConfig for the OAuth client secret.
   * If omitted, falls back to providerClientSecrets[mode].
   */
  clientSecretKey?: keyof VerificationConfig;
  /**
   * Extra OAuth query params appended to the authorization URL for this mode.
   * Merged with (and overridden by) providerExtraOAuthParams[mode] from VerificationConfig.
   */
  extraOAuthParams?: Record<string, string>;
}

/**
 * Gumroad OAuth configuration
 */
export const GUMROAD_CONFIG: VerificationModeConfig = {
  authUrl: 'https://gumroad.com/oauth/authorize',
  tokenUrl: 'https://api.gumroad.com/oauth/token',
  scopes: ['view_profile', 'view_sales'],
  callbackPath: '/api/verification/callback/gumroad',
  clientIdKey: 'gumroadClientId',
  clientSecretKey: 'gumroadClientSecret',
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
  clientIdKey: 'discordClientId',
  clientSecretKey: 'discordClientSecret',
  extraOAuthParams: { prompt: 'consent' },
};

/**
 * Jinxxy OAuth configuration
 */
export const JINXXY_CONFIG: VerificationModeConfig = {
  authUrl: 'https://jinxxy.com/oauth/authorize',
  tokenUrl: 'https://api.jinxxy.com/oauth/token',
  scopes: ['user:read', 'products:read', 'purchases:read'],
  callbackPath: '/api/verification/callback/jinxxy',
  clientIdKey: 'jinxxyClientId',
  clientSecretKey: 'jinxxyClientSecret',
};

/**
 * Get configuration for a verification mode.
 * Callback path uses 'discord' but internal mode is 'discord_role'.
 */
/**
 * Registry mapping verification mode → OAuth config.
 * Add a new entry here when adding a new OAuth provider.
 */
const VERIFICATION_CONFIGS: Record<string, VerificationModeConfig> = {
  gumroad: GUMROAD_CONFIG,
  discord: DISCORD_ROLE_CONFIG,
  discord_role: DISCORD_ROLE_CONFIG,
  jinxxy: JINXXY_CONFIG,
};

export function getVerificationConfig(mode: string): VerificationModeConfig | null {
  return VERIFICATION_CONFIGS[mode] ?? null;
}

/** Map callback path mode to Convex/identitySync provider name */
const MODE_TO_PROVIDER_MAP: Record<string, string> = {
  gumroad: 'gumroad',
  discord: 'discord',
  discord_role: 'discord',
  jinxxy: 'jinxxy',
};

function modeToProvider(mode: string): string | null {
  return MODE_TO_PROVIDER_MAP[mode] ?? null;
}

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
  /** Secret for decrypting tenant-stored keys (e.g. Jinxxy API key) */
  encryptionSecret?: string;
  /**
   * Generic OAuth client IDs for additional providers.
   * Keys are verification modes (e.g. 'myprovider'); values are client IDs.
   * Add new OAuth providers here without changing the interface.
   */
  providerClientIds?: Record<string, string>;
  /**
   * Generic OAuth client secrets for additional providers.
   * Keys are verification modes; values are client secrets.
   * Add new OAuth providers here without changing the interface.
   */
  providerClientSecrets?: Record<string, string>;
  /**
   * Extra OAuth query params per mode (e.g. { discord_role: { prompt: 'consent' } }).
   */
  providerExtraOAuthParams?: Record<string, Record<string, string>>;
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

      // Generate PKCE parameters
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await computeCodeChallenge(codeVerifier);
      const verifierHash = await hashVerifier(codeVerifier);

      // Generate state for callback lookup
      // Use verify_gumroad: prefix to distinguish from connect_gumroad:
      const state =
        input.mode === 'gumroad'
          ? `verify_gumroad:${input.authUserId}:${generateSecureRandom(48)}`
          : `${input.authUserId}:${generateSecureRandom(48)}`;

      // Build OAuth URL
      const authUrl = new URL(modeConfig.authUrl);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');

      // For Gumroad, use the unified callback URI to comply with Gumroad's single redirect URI limit
      const redirectUri =
        input.mode === 'gumroad'
          ? `${config.baseUrl}/api/connect/gumroad/callback`
          : `${config.baseUrl}${modeConfig.callbackPath}`;
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
          await store.set(`${PKCE_VERIFIER_PREFIX}${state}`, codeVerifier, SESSION_EXPIRY_MS);
          // redirectUri = user's destination after verification (e.g. /verify-success?returnTo=...)
          // OAuth redirect_uri for token exchange is always baseUrl + callbackPath
          const result = await convex.mutation(api.verificationSessions.createVerificationSession, {
            apiSecret: config.convexApiSecret,
            authUserId: input.authUserId,
            mode: input.mode,
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

      // Parse authUserId from state. Format can be:
      // - {authUserId}:{random}
      // - {prefix}:{authUserId}:{random} (e.g., verify_gumroad:{authUserId}:{random})
      const parts = state.split(':');
      if (parts.length < 2) {
        return { success: false, error: 'Invalid state parameter' };
      }

      // If 3 parts, the middle one is authUserId (e.g., prefix:authUserId:random)
      // If 2 parts, the first one is authUserId (e.g., authUserId:random)
      const authUserId = parts.length >= 3 ? parts[1] : parts[0];

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
      const codeVerifier = await store.get(`${PKCE_VERIFIER_PREFIX}${state}`);
      // Delete immediately after reading to enforce single-use
      await store.delete(`${PKCE_VERIFIER_PREFIX}${state}`);
      if (!codeVerifier) {
        return { success: false, error: 'Session missing PKCE verifier' };
      }

      // Exchange code for tokens
      const redirectUri =
        mode === 'gumroad'
          ? `${config.baseUrl}/api/connect/gumroad/callback`
          : `${config.baseUrl}${modeConfig.callbackPath}`;
      const tokenParams = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      });

      const tokenModeConfig = VERIFICATION_CONFIGS[mode];
      const clientId = tokenModeConfig?.clientIdKey
        ? (config[tokenModeConfig.clientIdKey] as string | undefined)
        : config.providerClientIds?.[mode];
      const clientSecret = tokenModeConfig?.clientSecretKey
        ? (config[tokenModeConfig.clientSecretKey] as string | undefined)
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
        const meRes = await fetch(
          `https://api.gumroad.com/v2/user?access_token=${encodeURIComponent(accessToken)}`
        );
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

const VRCHAT_TOKEN_PREFIX = 'vrchat_verify:';
const VRCHAT_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
const VRCHAT_VERIFY_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const VRCHAT_VERIFY_RATE_LIMIT_MAX = 10;

function getRequestIp(request: Request): string {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() || 'unknown';
  }
  return request.headers.get('x-real-ip') ?? 'unknown';
}

function withNoStore(headers?: unknown): Headers {
  const result = new Headers();
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result.set(key, value);
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      result.set(key, value);
    }
  } else if (headers && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string') {
        result.set(key, value);
      }
    }
  }
  result.set('Cache-Control', 'no-store');
  return result;
}

function jsonNoStore(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: withNoStore(init?.headers),
  });
}

function withSetCookies(headers: Headers, cookies: string[]): Headers {
  for (const cookie of cookies) {
    headers.append('Set-Cookie', cookie);
  }
  return headers;
}

function isVrchatRateLimited(token: string, request: Request): boolean {
  const now = Date.now();
  const key = `${token}:${getRequestIp(request)}`;
  const existing = VRCHAT_VERIFY_ATTEMPTS.get(key);
  if (!existing || now >= existing.resetAt) {
    VRCHAT_VERIFY_ATTEMPTS.set(key, {
      count: 1,
      resetAt: now + VRCHAT_VERIFY_RATE_LIMIT_WINDOW_MS,
    });
    return false;
  }

  existing.count += 1;
  VRCHAT_VERIFY_ATTEMPTS.set(key, existing);
  return existing.count > VRCHAT_VERIFY_RATE_LIMIT_MAX;
}

function isAllowedVrchatOrigin(request: Request, config: VerificationConfig): boolean {
  const origin = request.headers.get('origin');
  if (!origin) {
    return true;
  }

  try {
    const allowedOrigins = new Set([
      new URL(config.baseUrl).origin,
      new URL(config.frontendUrl).origin,
    ]);
    return allowedOrigins.has(origin);
  } catch {
    return false;
  }
}

interface StoredVerifyPanel {
  applicationId: string;
  discordUserId: string;
  guildId: string;
  /** AES-GCM encrypted interaction token (see INTERACTION_TOKEN_PURPOSE). */
  encryptedInteractionToken: string;
  messageId: string;
  authUserId: string;
}

function isAllowedVerifyPanelOrigin(request: Request, config: VerificationConfig): boolean {
  const origin = request.headers.get('origin');
  if (!origin) {
    return true;
  }

  try {
    const allowedOrigins = new Set([
      new URL(config.baseUrl).origin,
      new URL(config.frontendUrl).origin,
    ]);
    return allowedOrigins.has(origin);
  } catch {
    return false;
  }
}

function buildVerifyPanelRefreshReply() {
  return {
    components: [
      {
        type: 17,
        accent_color: 0x57f287,
        components: [
          {
            type: 10,
            content: '## You are verified',
          },
          {
            type: 14,
            divider: true,
            spacing: 1,
          },
          {
            type: 10,
            content:
              'Your account is connected. Roles will update shortly. If you want the full status panel again, use the button below.',
          },
          {
            type: 1,
            components: [
              {
                type: 2,
                custom_id: 'verify_start',
                label: 'Refresh Status',
                style: 1,
              },
            ],
          },
        ],
      },
    ],
    flags: 32768,
  };
}

/**
 * Creates route handlers for verification endpoints
 */
export function createVerificationRoutes(config: VerificationConfig) {
  const manager = createVerificationSessionManager(config);

  function hasValidApiSecret(value: string | undefined): boolean {
    return typeof value === 'string' && timingSafeStringEqual(value, config.convexApiSecret);
  }

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
          redirectUri: url.searchParams.get('redirectUri') ?? `${config.baseUrl}/verify-success`,
          discordUserId: url.searchParams.get('discordUserId') ?? undefined,
        };
      } else {
        body = (await request.json()) as CreateSessionInput;
      }

      if (!body.authUserId || !body.mode || !body.redirectUri) {
        return Response.json({ success: false, error: 'Missing required fields' }, { status: 400 });
      }

      // VRChat: no OAuth, create token and redirect to vrchat-verify page
      if ((body as { mode?: string }).mode === 'vrchat') {
        if (!body.discordUserId) {
          return Response.json(
            { success: false, error: 'discordUserId is required for VRChat verification' },
            { status: 400 }
          );
        }
        const { getStateStore } = await import('../lib/stateStore');
        const token = generateSecureRandom(32);
        const store = getStateStore();
        const payload = JSON.stringify({
          authUserId: body.authUserId,
          discordUserId: body.discordUserId,
          redirectUri: body.redirectUri,
        });
        await store.set(`${VRCHAT_TOKEN_PREFIX}${token}`, payload, VRCHAT_TOKEN_TTL_MS);
        const vrchatUrl = `${config.baseUrl}/vrchat-verify?token=${encodeURIComponent(token)}`;
        return Response.redirect(vrchatUrl, 302);
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

  async function bindVerifyPanel(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return jsonNoStore({ success: false, error: 'Method not allowed' }, { status: 405 });
    }

    let body: {
      apiSecret?: string;
      applicationId?: string;
      discordUserId?: string;
      guildId?: string;
      interactionToken?: string;
      messageId?: string;
      panelToken?: string;
      authUserId?: string;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch (err) {
      const support = await createApiVerificationSupportError(logger, {
        error: err,
        stage: 'bind_verify_panel_parse',
      });
      return jsonNoStore(
        { success: false, error: 'Invalid JSON', supportCode: support.supportCode },
        { status: 400 }
      );
    }

    if (!hasValidApiSecret(body.apiSecret)) {
      return jsonNoStore({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    if (
      !body.applicationId ||
      !body.discordUserId ||
      !body.guildId ||
      !body.interactionToken ||
      !body.messageId ||
      !body.panelToken ||
      !body.authUserId
    ) {
      return jsonNoStore({ success: false, error: 'Missing required fields' }, { status: 400 });
    }

    try {
      const { getStateStore } = await import('../lib/stateStore');
      const store = getStateStore();
      const encryptionSecret = config.encryptionSecret ?? '';
      const encryptedInteractionToken = encryptionSecret
        ? await encrypt(body.interactionToken, encryptionSecret, INTERACTION_TOKEN_PURPOSE)
        : body.interactionToken;
      await store.set(
        `${VERIFY_PANEL_PREFIX}${body.panelToken}`,
        JSON.stringify({
          applicationId: body.applicationId,
          discordUserId: body.discordUserId,
          guildId: body.guildId,
          encryptedInteractionToken,
          messageId: body.messageId,
          authUserId: body.authUserId,
        } satisfies StoredVerifyPanel),
        VERIFY_PANEL_TTL_MS
      );
      return jsonNoStore({ success: true }, { status: 200 });
    } catch (err) {
      const support = await createApiVerificationSupportError(logger, {
        discordUserId: body.discordUserId,
        error: err,
        guildId: body.guildId,
        stage: 'bind_verify_panel_store',
        authUserId: body.authUserId,
      });
      return jsonNoStore(
        { success: false, error: 'Internal server error', supportCode: support.supportCode },
        { status: 500 }
      );
    }
  }

  async function refreshVerifyPanel(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return jsonNoStore({ success: false, error: 'Method not allowed' }, { status: 405 });
    }

    if (!isAllowedVerifyPanelOrigin(request, config)) {
      return jsonNoStore({ success: false, error: 'Invalid request origin.' }, { status: 403 });
    }

    let body: { panelToken?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonNoStore({ success: false, error: 'Invalid JSON' }, { status: 400 });
    }

    const panelToken = body.panelToken?.trim();
    if (!panelToken) {
      return jsonNoStore({ success: false, error: 'Missing panel token' }, { status: 400 });
    }

    const { getStateStore } = await import('../lib/stateStore');
    const store = getStateStore();
    const raw = await store.get(`${VERIFY_PANEL_PREFIX}${panelToken}`);
    if (!raw) {
      return jsonNoStore({ success: false, error: 'Panel token expired' }, { status: 404 });
    }

    let panel: StoredVerifyPanel;
    try {
      panel = JSON.parse(raw) as StoredVerifyPanel;
    } catch {
      await store.delete(`${VERIFY_PANEL_PREFIX}${panelToken}`);
      return jsonNoStore({ success: false, error: 'Invalid panel token' }, { status: 400 });
    }

    const encryptionSecret = config.encryptionSecret ?? '';
    let interactionToken: string;
    try {
      interactionToken =
        encryptionSecret && panel.encryptedInteractionToken
          ? await decrypt(panel.encryptedInteractionToken, encryptionSecret, INTERACTION_TOKEN_PURPOSE)
          : panel.encryptedInteractionToken;
    } catch {
      await store.delete(`${VERIFY_PANEL_PREFIX}${panelToken}`);
      return jsonNoStore({ success: false, error: 'Invalid panel token' }, { status: 400 });
    }

    const discordResponse = await fetch(
      `https://discord.com/api/v10/webhooks/${panel.applicationId}/${interactionToken}/messages/${panel.messageId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildVerifyPanelRefreshReply()),
      }
    );

    if (!discordResponse.ok) {
      const errorBody = await discordResponse.text().catch(() => '');
      const support = await createApiVerificationSupportError(logger, {
        discordUserId: panel.discordUserId,
        error: new Error(`Discord refresh failed with status ${discordResponse.status}`),
        guildId: panel.guildId,
        stage: 'refresh_verify_panel_discord',
        authUserId: panel.authUserId,
      });
      logger.warn('Failed to refresh verify panel from success page', {
        bodyPreview: errorBody.slice(0, 300),
        discordStatus: discordResponse.status,
        guildId: panel.guildId,
        supportCode: support.supportCode,
        supportCodeMode: support.supportCodeMode,
        userId: panel.discordUserId,
      });
      return jsonNoStore(
        {
          success: false,
          error: 'Failed to update Discord panel',
          supportCode: support.supportCode,
        },
        { status: 502 }
      );
    }

    await store.delete(`${VERIFY_PANEL_PREFIX}${panelToken}`);
    return jsonNoStore({ success: true }, { status: 200 });
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
   * POST /api/verification/complete-vrchat
   * Completes VRChat verification - credentials, fetch licensed avatars, grant matching products
   */
  async function completeVrchatVerification(_request: Request): Promise<Response> {
    return Response.json(
      {
        success: false,
        error: 'Use /api/verification/vrchat-verify for VRChat verification.',
      },
      { status: 410 }
    );
  }

  type BetterAuthVrchatSessionResult =
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

  type StoredVrchatSessionResult =
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

  function parseTwoFactorType(type: string | undefined): TwoFactorAuthType | undefined {
    if (type === 'totp' || type === 'emailOtp' || type === 'otp') {
      return type;
    }
    return undefined;
  }

  function buildSessionFromAuthResult(result: {
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

  async function persistVrchatSession(
    betterAuth: ReturnType<typeof createAuth>,
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

  async function getStoredVrchatSession(
    betterAuth: ReturnType<typeof createAuth>,
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

  async function clearStoredVrchatSession(
    betterAuth: ReturnType<typeof createAuth>,
    requestCookieHeader: string,
    betterAuthCookieHeader: string
  ): Promise<void> {
    try {
      await betterAuth.clearVrchatSession(betterAuthCookieHeader, requestCookieHeader);
    } catch {
      // Best-effort cleanup only.
    }
  }

  async function getOwnershipFromSession(
    client: VrchatApiClient,
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

  async function ensureVrchatSubjectId(
    _authUserId: string,
    discordUserId: string
  ): Promise<string> {
    const convex = getConvexClientFromUrl(config.convexUrl);
    const ensureResult = await convex.mutation(api.subjects.ensureSubjectForDiscord, {
      apiSecret: config.convexApiSecret,
      discordUserId,
      displayName: undefined,
      avatarUrl: undefined,
    });
    return ensureResult.subjectId;
  }

  /**
   * POST /api/verification/vrchat-verify
   * Token-based VRChat verification for the vrchat-verify webpage.
   *
   * Body:
   * - Auto verify: { token }
   * - Password step: { token, username, password, twoFactorCode? }
   * - 2FA step: { token, twoFactorCode, pendingToken?, type? }
   */
  async function vrchatVerify(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return jsonNoStore({ error: 'Method not allowed' }, { status: 405 });
    }

    let body: {
      token?: string;
      username?: string;
      password?: string;
      twoFactorCode?: string;
      pendingToken?: string;
      type?: string;
    };
    try {
      body = (await request.json()) as typeof body;
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
          error: 'Invalid or expired link. Please use the Verify with VRChat button in Discord.',
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

    const { getStateStore } = await import('../lib/stateStore');
    const store = getStateStore();
    const raw = await store.get(`${VRCHAT_TOKEN_PREFIX}${token}`);
    if (!raw) {
      return jsonNoStore(
        {
          success: false,
          error: 'Invalid or expired link. Please use the Verify with VRChat button in Discord.',
        },
        { status: 400 }
      );
    }

    let payload: { authUserId: string; discordUserId: string; redirectUri?: string };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      await store.delete(`${VRCHAT_TOKEN_PREFIX}${token}`);
      return jsonNoStore(
        { success: false, error: 'Invalid token. Please try again from Discord.' },
        { status: 400 }
      );
    }

    const { authUserId, discordUserId } = payload;
    const convexSiteUrl = config.convexUrl
      ? config.convexUrl.replace('.convex.cloud', '.convex.site')
      : '';
    const requestCookieHeader = request.headers.get('cookie') ?? '';
    const betterAuth = createAuth({
      baseUrl: config.baseUrl,
      convexSiteUrl,
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

      async function finalizeOwnership(
        ownership: VrchatOwnershipPayload,
        responseHeaders?: Headers
      ): Promise<Response> {
        let subjectId: string;
        try {
          subjectId = await ensureVrchatSubjectId(authUserId, discordUserId);
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
              headers: responseHeaders ?? withNoStore({ 'Content-Type': 'application/json' }),
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
              headers: responseHeaders ?? withNoStore({ 'Content-Type': 'application/json' }),
            }
          );
        }

        await store.delete(`${VRCHAT_TOKEN_PREFIX}${token}`);
        return jsonNoStore(
          {
            success: true,
            entitlementIds: result.entitlementIds,
            redirectUri: payload.redirectUri,
          },
          {
            status: 200,
            headers: responseHeaders ?? withNoStore({ 'Content-Type': 'application/json' }),
          }
        );
      }

      if (pendingToken || (!username && !password && twoFactorCode)) {
        if (!twoFactorCode) {
          return jsonNoStore(
            { success: false, error: 'Two-factor authentication code is required.' },
            { status: 400 }
          );
        }

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

          return finalizeOwnership(ownership, responseHeaders);
        } catch (error) {
          logger.warn('VRChat verify 2FA failed', {
            tokenSuffix,
            error: error instanceof Error ? error.message : String(error),
          });
          await clearPendingVrchatState(store, request, responseHeaders);
          return jsonNoStore(
            {
              success: false,
              error: 'Verification failed. Please check your credentials and try again.',
            },
            { status: 401, headers: responseHeaders }
          );
        }
      }

      if (username && password) {
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
              error: 'Verification failed. Please check your credentials and try again.',
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

              return finalizeOwnership(ownership, responseHeaders);
            } catch (error) {
              logger.warn('VRChat verify password step: stale-client inline 2FA failed', {
                tokenSuffix,
                error: error instanceof Error ? error.message : String(error),
              });
              return jsonNoStore(
                {
                  success: false,
                  error: 'Verification failed. Please check your credentials and try again.',
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
              error: 'Verification failed. Please check your credentials and try again.',
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

        return finalizeOwnership(ownership, responseHeaders);
      }

      const storedSessionResult = await getStoredVrchatSession(
        betterAuth,
        requestCookieHeader,
        requestCookieHeader
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
        await clearStoredVrchatSession(betterAuth, requestCookieHeader, requestCookieHeader);
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

      return finalizeOwnership(ownership);
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
      if (!username && !password && !twoFactorCode) {
        return jsonNoStore(
          {
            success: false,
            error: 'Please enter your VRChat username and password to verify.',
            needsCredentials: true,
            sessionExpired: true,
          },
          { status: 401 }
        );
      }

      return jsonNoStore(
        {
          success: false,
          error: 'Verification failed. Please check your credentials and try again.',
        },
        { status: 401 }
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
  routeMap.set('/api/verification/callback/jinxxy', routes.handleVerificationCallback);
  routeMap.set('/api/verification/complete', routes.completeVerification);
  routeMap.set('/api/verification/complete-license', routes.completeLicenseVerification);
  routeMap.set('/api/verification/complete-vrchat', routes.completeVrchatVerification);
  routeMap.set('/api/verification/vrchat-verify', routes.vrchatVerify);
  routeMap.set('/api/verification/disconnect', routes.disconnectVerification);

  return routeMap;
}
export type VerificationRouteHandlers = ReturnType<typeof createVerificationRoutes>;
